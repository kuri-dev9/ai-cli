import { randomBytes } from 'node:crypto';

import { isShareActive, messageSourcesDb, sessionSharesDb, sessionsDb } from '@/modules/database/index.js';
import type { SessionShareRow } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { isSessionHandedToTelegram } from '@/modules/telegram-bridge/index.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * 세션을 로그인 없이 바깥에 여는 공유 링크.
 *
 * 링크를 받은 사람(게스트)은 그 세션 하나만 읽고 질문할 수 있다. 게스트가
 * 보낸 질문은 텔레그램과 같은 길(`runDetachedChatTurn`)로 들어가므로, 주인의
 * 브라우저에는 평소처럼 실행이 보이고 기록에는 "게스트" 배지가 붙는다.
 *
 * 게스트에게 내려가는 것은 화면을 그릴 만큼만이다. 도구 결과 본문(파일 내용,
 * 명령 출력)과 생각 과정은 보내지 않는다 — 대화를 따라가는 데는 필요 없고,
 * 링크 하나로 새어 나가기에는 너무 많은 것이 들어 있다.
 */

/** 브라우저가 고를 수 있는 권한. 서버는 이 중 하나만 받는다. */
export const SHARE_PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'] as const;
export type SharePermissionMode = (typeof SHARE_PERMISSION_MODES)[number];

/** 링크 유효 기간으로 고를 수 있는 값(시간). `null` 은 무기한. */
export const SHARE_EXPIRY_HOURS = [1, 24, 24 * 7] as const;

/** 게스트 질문 한 번의 최대 길이. 붙여넣기 한 번으로 모델 문맥을 다 채우지 못하게. */
export const GUEST_MESSAGE_MAX_LENGTH = 8_000;

/** 처음 열 때 내려줄 최근 메시지 수. 긴 세션 전체를 링크 한 번에 보내지 않는다. */
const GUEST_HISTORY_LIMIT = 300;

/** 도구 줄에 붙일 짧은 설명의 최대 길이. */
const TOOL_DETAIL_MAX_LENGTH = 160;

export function parseSharePermissionMode(value: unknown): SharePermissionMode | null {
  return SHARE_PERMISSION_MODES.includes(value as SharePermissionMode)
    ? (value as SharePermissionMode)
    : null;
}

/** 게스트 화면이 그리는 한 줄. */
export type GuestMessage =
  | {
      id: string;
      kind: 'text';
      role: 'user' | 'assistant';
      content: string;
      timestamp: string;
      source?: 'telegram' | 'share';
    }
  | { id: string; kind: 'tool'; toolName: string; detail: string | null; timestamp: string }
  | { id: string; kind: 'error'; content: string; timestamp: string };

/** 실행 중에 게스트가 받아 가는 조각. `delta` 는 답이 써지는 중인 글이다. */
export type GuestLiveEvent = GuestMessage | { kind: 'delta'; content: string };

function shareNotFound(): AppError {
  // 없는 링크와 끝난 링크를 구분하지 않는다. 구분해 주면 토큰을 하나씩
  // 맞혀 보는 쪽에 "이건 있던 링크"라는 힌트가 된다.
  return new AppError('This share link is not available.', {
    code: 'SHARE_NOT_FOUND',
    statusCode: 404,
  });
}

/** 추측할 수 없는 토큰. URL 에 그대로 넣을 수 있게 base64url 로 만든다. */
function createShareToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * 토큰으로 링크와 세션을 찾는다. 만료·철회됐거나 세션이 사라졌으면 404.
 */
export function resolveActiveShare(token: string): { share: SessionShareRow; sessionId: string } {
  const share = token ? sessionSharesDb.getByToken(token) : null;
  if (!share || !isShareActive(share)) {
    throw shareNotFound();
  }
  if (!sessionsDb.getSessionById(share.session_id)) {
    throw shareNotFound();
  }
  return { share, sessionId: share.session_id };
}

/** 도구 입력에서 사람이 알아볼 만한 한 줄을 뽑는다. 무엇을 했는지만 보이면 된다. */
function describeToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const text = value.trim().replace(/\s+/g, ' ');
      return text.length > TOOL_DETAIL_MAX_LENGTH ? `${text.slice(0, TOOL_DETAIL_MAX_LENGTH)}…` : text;
    }
  }
  return null;
}

/** 기록 한 줄을 게스트 화면용으로 줄인다. 보여줄 것이 없으면 `null`. */
export function toGuestMessage(message: NormalizedMessage): GuestMessage | null {
  const timestamp = message.timestamp ?? new Date().toISOString();

  if (message.kind === 'text') {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return null;
    }
    // 자동 대화 줄이기의 요약과 슬래시 명령 출력은 대화가 아니다.
    if (message.isCompactSummary || message.isLocalCommandStdout) {
      return null;
    }
    const content = (message.displayText ?? message.content ?? '').trim();
    if (!content) {
      return null;
    }
    return {
      id: message.id,
      kind: 'text',
      role: message.role,
      content,
      timestamp,
      ...(message.source ? { source: message.source } : {}),
    };
  }

  if (message.kind === 'tool_use' && message.toolName) {
    return {
      id: message.id,
      kind: 'tool',
      toolName: message.toolName,
      detail: describeToolInput(message.toolInput),
      timestamp,
    };
  }

  if (message.kind === 'error' && message.content?.trim()) {
    return { id: message.id, kind: 'error', content: message.content.trim(), timestamp };
  }

  return null;
}

/** 지금 실행의 상태. 실행이 바뀌었는지는 `runKey` 로 안다 — `seq` 는 실행마다 1 부터 다시 센다. */
function readRunState(sessionId: string) {
  const run = chatRunRegistry.getRun(sessionId);
  return {
    isProcessing: chatRunRegistry.isProcessing(sessionId),
    runKey: run ? String(run.startedAt) : null,
    lastSeq: run?.lastSeq ?? 0,
  };
}

function hasPendingApproval(runtime: ProviderRuntimeGateway, sessionId: string): boolean {
  return runtime.getPendingApprovalsForSession(sessionId).length > 0;
}

function readSessionTitle(sessionId: string): string | null {
  const session = sessionsDb.getSessionById(sessionId);
  return session?.custom_name?.trim() || null;
}

export function createSessionShare(input: {
  sessionId: string;
  userId: number | null;
  permissionMode: SharePermissionMode;
  expiresInHours: number | null;
}): SessionShareRow {
  if (!sessionsDb.getSessionById(input.sessionId)) {
    throw new AppError(`Session "${input.sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  const expiresAt = input.expiresInHours === null
    ? null
    : new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000).toISOString();

  return sessionSharesDb.create({
    token: createShareToken(),
    sessionId: input.sessionId,
    permissionMode: input.permissionMode,
    createdBy: input.userId,
    expiresAt,
  });
}

/** 게스트가 링크를 처음 열 때 받는 것: 세션 제목, 최근 대화, 지금 실행 상태. */
export async function readGuestSnapshot(token: string, runtime: ProviderRuntimeGateway) {
  const { share, sessionId } = resolveActiveShare(token);
  const history = await sessionsService.fetchHistory(sessionId, { limit: GUEST_HISTORY_LIMIT, offset: 0 });
  const messages = (history.messages as NormalizedMessage[])
    .map(toGuestMessage)
    .filter((message): message is GuestMessage => message !== null);

  return {
    title: readSessionTitle(sessionId),
    expiresAt: share.expires_at,
    messages,
    hasMore: history.hasMore,
    ...readRunState(sessionId),
    awaitingApproval: hasPendingApproval(runtime, sessionId),
  };
}

/**
 * 실행 중에 게스트가 주기적으로 받아 가는 새 조각.
 *
 * 게스트는 웹소켓을 쓰지 않는다. 웹소켓은 로그인한 사용자의 모든 세션을 오가는
 * 통로라, 링크 하나에 그 문을 열어 줄 수 없다. 대신 이 세션의 실행 버퍼만 짧게
 * 물어본다.
 */
export function readGuestEvents(
  token: string,
  runtime: ProviderRuntimeGateway,
  cursor: { runKey: string | null; afterSeq: number },
) {
  const { sessionId } = resolveActiveShare(token);
  const state = readRunState(sessionId);
  // 다른 실행이 시작됐으면 처음부터 받는다. 들고 온 `seq` 는 앞 실행의 것이다.
  const afterSeq = cursor.runKey && cursor.runKey === state.runKey
    ? Math.min(cursor.afterSeq, state.lastSeq)
    : 0;

  const events: GuestLiveEvent[] = [];
  for (const event of chatRunRegistry.replayEvents(sessionId, afterSeq)) {
    if (event.kind === 'stream_delta' && event.content) {
      events.push({ kind: 'delta', content: event.content });
      continue;
    }
    const message = toGuestMessage(event);
    if (message) {
      events.push(message);
    }
  }

  return {
    ...state,
    events,
    awaitingApproval: hasPendingApproval(runtime, sessionId),
  };
}

/** 실행이 시작됐는지 확인하며 기다리는 최대 시간. 대화 줄이기가 앞서 돌면 더 걸릴 수 있다. */
const START_CONFIRM_TIMEOUT_MS = 3_000;
const START_CONFIRM_POLL_MS = 50;

/**
 * 시작을 기다리는 중인 세션. 두 요청이 거의 동시에 오면 둘 다 "작업 중 아님"을
 * 보고 들어올 수 있어서, 실행이 등록될 때까지 여기서 막는다.
 */
const startingSessions = new Set<string>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 게스트 질문을 세션에 넣는다.
 *
 * 권한은 링크에 적힌 값(= 주인이 이 세션에 고른 권한)을 쓴다. `default` 면
 * 도구 승인은 주인의 브라우저에 뜨고, 주인이 답할 때까지 게스트는 기다린다.
 *
 * 작업 중이면 줄을 세우지 않고 거절한다. 게스트가 쌓아 둔 질문이 주인의 다음
 * 작업 뒤에 몰래 실행되는 일은 없어야 한다.
 *
 * `runDetachedChatTurn` 은 실행이 끝나야 돌아온다. 요청을 그동안 붙잡아 두지
 * 않도록, 실행이 등록된 것만 보고 돌아오고 결과는 게스트가 이벤트로 받아 간다.
 */
export async function sendGuestMessage(
  token: string,
  content: string,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const { share, sessionId } = resolveActiveShare(token);
  const prompt = content.trim();
  if (!prompt) {
    throw new AppError('Message is empty.', { code: 'SHARE_MESSAGE_EMPTY', statusCode: 400 });
  }
  if (prompt.length > GUEST_MESSAGE_MAX_LENGTH) {
    throw new AppError(`Message is longer than ${GUEST_MESSAGE_MAX_LENGTH} characters.`, {
      code: 'SHARE_MESSAGE_TOO_LONG',
      statusCode: 400,
    });
  }
  if (startingSessions.has(sessionId) || chatRunRegistry.isProcessing(sessionId)) {
    throw sessionBusy();
  }

  const permissionMode = parseSharePermissionMode(share.permission_mode) ?? 'default';
  const sourceMarkId = messageSourcesDb.markMessageSource(sessionId, prompt, 'share');
  const previousRunKey = readRunState(sessionId).runKey;

  startingSessions.add(sessionId);
  let settled: { started: boolean; error: string | null } | null = null;
  const run = runDetachedChatTurn(
    {
      sessionId,
      userId: share.created_by,
      content: prompt,
      // Cursor 는 `permissionMode` 대신 `skipPermissions` 를 본다. 텔레그램의
      // `full` 과 같은 짝으로 넘긴다.
      options: {
        permissionMode,
        ...(permissionMode === 'bypassPermissions' ? { skipPermissions: true } : {}),
      },
      origin: 'share',
    },
    { runtime, isSessionHandedToTelegram },
  )
    .then((result) => {
      settled = result;
      if (!result.started) {
        // 기록에 남지 않은 턴의 표시를 남겨 두면, 나중에 같은 글에 배지가 잘못 붙는다.
        messageSourcesDb.dropMessageSource(sourceMarkId);
      }
      return result;
    })
    .catch((error: unknown) => {
      const failure = { started: false, error: error instanceof Error ? error.message : String(error) };
      settled = failure;
      messageSourcesDb.dropMessageSource(sourceMarkId);
      return failure;
    })
    .finally(() => {
      startingSessions.delete(sessionId);
    });

  // 막아 둔 표시는 실행이 끝날 때(`finally`) 푼다. 그 전까지는 어차피 작업
  // 중이라 다른 질문을 받을 수 없다.
  void run;

  const deadline = Date.now() + START_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline && !settled) {
    const state = readRunState(sessionId);
    if (state.isProcessing && state.runKey !== previousRunKey) {
      return;
    }
    await sleep(START_CONFIRM_POLL_MS);
  }

  const result = settled as { started: boolean; error: string | null } | null;
  if (result && !result.started) {
    throw new AppError(result.error ?? 'Could not start the run.', {
      code: 'SHARE_RUN_FAILED',
      statusCode: 409,
    });
  }
  // 아직 시작 전이면(앞서 대화 줄이기가 도는 중) 받아 둔 것으로 본다.
}

function sessionBusy(): AppError {
  return new AppError('The session is busy. Try again when the current answer is finished.', {
    code: 'SHARE_SESSION_BUSY',
    statusCode: 409,
  });
}
