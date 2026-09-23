import path from 'node:path';

import type { WebSocket } from 'ws';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import type { ChatRunOrigin } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import {
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them into the prompt). Only images
 * that live directly inside the global upload store (`~/.cloudcli/assets`,
 * where POST /api/assets/images puts them) are allowed through — anything
 * else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 *
 * Exported for tests; `assetsRootOverride` exists only for them.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoot = path.resolve(assetsRootOverride ?? getGlobalImageAssetsDir());

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in the store; absolute ones must already be in it.
    const resolved = path.resolve(assetsRoot, descriptor.path);
    const relative = path.relative(assetsRoot, resolved);
    const isDirectChild =
      relative.length > 0 &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      !relative.includes(path.sep) &&
      !relative.includes('/');

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}

/**
 * 이 실행 하나의 결과를 텔레그램으로도 보내 달라는 표시.
 *
 * 웹에서 시작한 실행은 기본적으로 조용하다(브라우저에서 대화할 때마다 폰이
 * 울리면 알림이 소음이 된다). 한 번만 받고 싶을 때 입력 맨 앞에 붙인다.
 */
export const TELEGRAM_RELAY_PREFIX = '/bot';

const TELEGRAM_RELAY_PREFIX_PATTERN = /^\/bot(?:\s+|$)/i;

/**
 * 프롬프트에서 `/bot` 접두어를 떼어 내고, 붙어 있었는지 알려준다.
 *
 * 판정은 반드시 서버에서 한다 — 접두어를 화면에서만 떼면 다른 클라이언트(또는
 * 손으로 만든 websocket 프레임)에서 온 `/bot` 이 그대로 모델에게 흘러간다.
 *
 * 뒤에 내용이 없는 `/bot` 하나만 온 경우는 접두어로 보지 않는다. 그렇게 보면
 * 빈 프롬프트로 한 턴이 시작되는데, 사용자가 원한 것은 명령을 고르던 중이거나
 * 오타였을 가능성이 훨씬 높다.
 */
export function parseTelegramRelayPrefix(raw: string): { content: string; relayRequested: boolean } {
  const text = raw.trimStart();
  const match = TELEGRAM_RELAY_PREFIX_PATTERN.exec(text);
  if (!match) {
    return { content: raw, relayRequested: false };
  }

  const rest = text.slice(match[0].length);
  if (!rest.trim()) {
    return { content: raw, relayRequested: false };
  }
  return { content: rest, relayRequested: true };
}

/**
 * 폰으로 넘어간 턴에 얼마나 허용할지.
 *
 * - `ask`   평소처럼 승인을 묻는다. 기본값.
 * - `read`  읽기 도구만 자동 허용하고, 고치거나 실행하는 것은 묻는다.
 * - `full`  묻지 않는다.
 *
 * 왜 고르게 하는가: 승인 창은 붙어 있는 브라우저에만 그려진다. 폰에는 아무것도
 * 뜨지 않은 채 55초 뒤 거부로 끝나므로, `ask` 로 두면 폰에서는 읽기조차 사실상
 * 막힌다. 그렇다고 `full` 이 기본일 수는 없다 — 폰에서 보낸 한 줄이 파일
 * 삭제나 배포까지 아무도 승인하지 않은 채 실행한다.
 *
 * `read` 가 그 사이다. 폰에서 코드를 훑고 상황을 묻는 데는 충분하면서, 뭔가를
 * 바꾸려는 순간에는 멈춰 선다.
 */
export type TelegramPermissionMode = 'ask' | 'read' | 'full';

/** 설정 화면이 쓰는 저장 키. `telegram-settings` 가 같이 읽고 쓴다. */
export const TELEGRAM_PERMISSION_MODE_KEY = 'telegram.permissionMode';

export const TELEGRAM_PERMISSION_MODES: TelegramPermissionMode[] = ['ask', 'read', 'full'];

/**
 * `read` 에서 자동으로 허용할 도구.
 *
 * 읽기만 하고 아무것도 남기지 않는 것만 넣는다. `Bash` 는 읽는 명령도 있지만
 * 같은 도구로 지울 수도 있어서 넣지 않는다 — 도구 이름만으로는 가를 수 없다.
 *
 * 이름이 정확히 맞아야 통과한다. 런타임의 허용 규칙이 정확한 이름과 `Bash(...)`
 * 축약만 알아보기 때문이다.
 */
export const TELEGRAM_READ_ONLY_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
];

export function parseTelegramPermissionMode(value: unknown): TelegramPermissionMode {
  return TELEGRAM_PERMISSION_MODES.includes(value as TelegramPermissionMode)
    ? (value as TelegramPermissionMode)
    : 'ask';
}

/**
 * 지금 설정된 값. 저장돼 있지 않으면 `ask`.
 *
 * 턴마다 읽는다. 설정 화면에서 방금 바꾼 값이 다음 턴부터 듣지 않으면 왜 안
 * 되는지 알 길이 없고, 키 하나 읽는 비용은 턴당 무시할 만하다.
 */
export function readTelegramPermissionMode(): TelegramPermissionMode {
  return parseTelegramPermissionMode(appConfigDb.get(TELEGRAM_PERMISSION_MODE_KEY));
}

/**
 * 폰으로 넘어간 턴에 붙일 실행 옵션.
 *
 * 프로바이더마다 읽는 자리가 달라 두 가지를 같이 넘긴다. Claude 와 Codex 는
 * `permissionMode` 를, Cursor 는 `skipPermissions` 를 본다.
 *
 * `read` 는 허용 목록으로 푼다. 이 경로의 턴은 컴포저가 없어 `toolsSettings` 를
 * 아무것도 보내지 않으므로, 여기서 넣는 것이 사용자의 설정을 덮는 일은 없다.
 */
export function resolveTelegramRunPermissions(mode: TelegramPermissionMode): AnyRecord {
  if (mode === 'full') {
    return { permissionMode: 'bypassPermissions', skipPermissions: true };
  }
  if (mode === 'read') {
    return {
      toolsSettings: {
        allowedTools: [...TELEGRAM_READ_ONLY_TOOLS],
        disallowedTools: [],
        skipPermissions: false,
      },
    };
  }
  return {};
}

/**
 * `/bot` 의 반대. 이 대화를 폰에서 놓고 브라우저로 되돌린다.
 *
 * 돌아왔을 때 폰이 계속 울리는 것을 멈추는 길이 UI 안에 있어야 한다 — 그러자고
 * 텔레그램을 열어 `/unwatch` 를 치는 것은 앞뒤가 바뀐 일이다.
 *
 * `/bot` 과 달리 뒤에 내용이 없어도 명령으로 본다. 놓는 것은 그 자체로 끝나는
 * 일이고, 보낼 말이 없어도 놓고 싶을 때가 대부분이다. 내용이 붙어 있으면 놓은
 * 뒤에 그 턴을 평소처럼 브라우저에서 돌린다.
 */
export const TELEGRAM_RELEASE_PREFIX = '/unbot';

const TELEGRAM_RELEASE_PREFIX_PATTERN = /^\/unbot(?:\s+|$)/i;

export function parseTelegramReleasePrefix(raw: string): {
  content: string;
  releaseRequested: boolean;
} {
  const text = raw.trimStart();
  const match = TELEGRAM_RELEASE_PREFIX_PATTERN.exec(text);
  if (!match) {
    return { content: raw, releaseRequested: false };
  }
  return { content: text.slice(match[0].length), releaseRequested: true };
}

/** Application boundary for dispatching provider runs and approvals. */
export type ProviderRuntimeGateway = {
  hasRuntime(provider: string): boolean;
  run(
    provider: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown>;
  abort(provider: LLMProvider, sessionId: string): Promise<boolean>;
  resolveToolApproval(requestId: string, payload: ProviderPermissionDecision): void;
  getPendingApprovalsForSession(sessionId: string): unknown[];
};

type ChatWebSocketDependencies = {
  /** Central dispatcher for every provider SDK/CLI runtime. */
  runtime: ProviderRuntimeGateway;
};

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WS_OPEN_STATE) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Reports a protocol-level failure to the requesting client.
 *
 * Protocol errors deliberately use their own `kind` (instead of the provider
 * `error` message kind) so the frontend can distinguish "your request was
 * invalid" from "the model run produced an error" without inspecting text.
 */
function sendProtocolError(
  ws: WebSocket,
  code: string,
  error: string,
  sessionId?: string
): void {
  sendJson(ws, {
    kind: 'protocol_error',
    code,
    error,
    sessionId: sessionId ?? null,
    timestamp: new Date().toISOString(),
  });
}

function readRequiredSessionId(data: AnyRecord): string | null {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  return sessionId.length > 0 ? sessionId : null;
}

/**
 * Handles `chat.send`: resolves the session row (provider, project path, and
 * provider-native id all come from the database — never from the client),
 * registers the run, and dispatches to the provider runtime.
 */
async function handleChatSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.send');
  if (!resolved) {
    return;
  }

  // `/unbot` 은 모델에게 갈 말이 아니라 통로를 끊는 신호다. 접두어는 여기서
  // 떼어 내고, 남은 내용이 없으면 턴 없이 끝낸다 — 놓기만 하려던 사람에게
  // 빈 프롬프트로 한 턴을 돌려 주지 않는다.
  const release = parseTelegramReleasePrefix(
    typeof data.content === 'string' ? data.content : '',
  );
  if (release.releaseRequested) {
    chatRunRegistry.releaseRelay(resolved.sessionId);
    if (!release.content.trim()) {
      return;
    }
    data = { ...data, content: release.content };
  }

  await dispatchRun(ws, userId, resolved.sessionId, resolved.session, data, dependencies);
}

type ResolvedSendTarget = {
  sessionId: string;
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;
  provider: LLMProvider;
};

/**
 * Shared front half of `chat.send` and `chat.edit-send`: the session row and
 * provider come from the database, never from the client.
 */
function resolveSendTarget(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  frameName: string,
): ResolvedSendTarget | null {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', `${frameName} requires a sessionId.`);
    return null;
  }

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    sendProtocolError(
      ws,
      'SESSION_NOT_FOUND',
      `Session "${sessionId}" was not found. Create it via POST /api/providers/sessions first.`,
      sessionId
    );
    return null;
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    sendProtocolError(ws, 'UNSUPPORTED_PROVIDER', `Provider "${provider}" is not available.`, sessionId);
    return null;
  }

  return { sessionId, session, provider };
}

/**
 * Registers the run and hands the turn to the provider runtime.
 *
 * `extraRuntimeOptions` is how an edited message asks the provider to resume
 * partway instead of continuing from the tip; a normal send passes nothing.
 */
async function dispatchRun(
  ws: WebSocket | null,
  userId: string | number | null,
  sessionId: string,
  session: NonNullable<ReturnType<typeof sessionsDb.getSessionById>>,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies,
  extraRuntimeOptions: AnyRecord = {},
  beforeRun?: (run: NonNullable<ReturnType<typeof chatRunRegistry.startRun>>) => void | Promise<void>,
  origin: ChatRunOrigin = 'web',
): Promise<{ started: boolean; error: string | null }> {
  const provider = session.provider as LLMProvider;

  // 접두어는 실행을 등록하기 전에 뗀다. 등록할 때 "이 실행만 중계" 표시를
  // 같이 남겨야 하고, 프로바이더에게는 접두어를 뗀 본문만 가야 한다.
  const relay = parseTelegramRelayPrefix(typeof data.content === 'string' ? data.content : '');

  const run = chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider,
    providerSessionId: session.provider_session_id,
    connection: ws,
    userId,
    origin,
    relayRequested: relay.relayRequested,
  });

  if (!run) {
    if (ws) {
      sendProtocolError(
        ws,
        'RUN_IN_PROGRESS',
        `Session "${sessionId}" already has a run in progress.`,
        sessionId
      );
    }
    return { started: false, error: 'A run is already in progress for this session.' };
  }

  const clientOptions = (data.options ?? {}) as AnyRecord;
  const command = relay.content;

  // Record what this turn runs with so reopening the session later restores the
  // same model and reasoning effort, and so the resume path has a
  // session-scoped model answer to use.
  if (typeof clientOptions.model === 'string' && clientOptions.model.trim()) {
    providerModelsService.setSessionModel(provider, sessionId, clientOptions.model);
  }
  if (typeof clientOptions.effort === 'string' && clientOptions.effort.trim()) {
    providerModelsService.setSessionEffort(provider, sessionId, clientOptions.effort);
  }

  const attachmentCandidates = [
    ...normalizeAttachmentDescriptors(clientOptions.images),
    ...normalizeAttachmentDescriptors(clientOptions.files),
    ...normalizeAttachmentDescriptors(clientOptions.attachments),
  ];
  const verifiedAttachments = filterAttachmentsToUploadStore(attachmentCandidates);
  const uniqueAttachments = verifiedAttachments.filter(
    (descriptor, index, all) => all.findIndex((candidate) => candidate.path === descriptor.path) === index,
  );

  // The provider runtimes receive the stable app session id. When their
  // CLI/SDK needs the provider-native id for resume, they resolve it from the
  // session row themselves (sessionsService.resolveProviderSessionId).
  // Brand-new sessions have no provider id yet, so the runtime starts fresh
  // and announces one, which the gateway writer captures and maps back to the
  // app session id.
  const runtimeOptions: AnyRecord = {
    ...clientOptions,
    ...extraRuntimeOptions,
    // Attachments are re-validated server-side: only direct children of the
    // global upload store may reach provider runtimes or their file tools.
    attachments: uniqueAttachments,
    images: uniqueAttachments.filter(isImageAttachmentDescriptor),
    files: uniqueAttachments.filter((descriptor) => !isImageAttachmentDescriptor(descriptor)),
    sessionId,
    cwd: clientOptions.cwd ?? session.project_path ?? undefined,
    projectPath: session.project_path ?? clientOptions.projectPath,
    // 폰으로 넘어간 턴은 승인을 물을 자리가 없다. 승인 요청은 붙어 있는
    // 브라우저로만 그려지고, 텔레그램에는 아무것도 뜨지 않은 채 55초 뒤 거부로
    // 끝난다. 얼마나 허용할지는 설정 화면에서 고른다 —
    // `readTelegramPermissionMode` 참고.
    //
    // 대상은 두 가지뿐이다: 텔레그램에서 보낸 턴과, `/bot` 으로 넘긴 그 턴. 둘 다
    // 사용자가 브라우저를 떠나겠다고 방금 말한 경우다. 브라우저에서 그냥 보낸
    // 턴은 손대지 않는다.
    ...(origin === 'telegram' || relay.relayRequested
      ? resolveTelegramRunPermissions(readTelegramPermissionMode())
      : {}),
  };

  // 브라우저가 시키지 않은 턴은 화면에 아무 말도 남기지 않은 채 시작된다.
  // 텔레그램으로 한 줄 보내 놓고 웹 화면을 보고 있으면, 보낸 글은 보이지 않고
  // 표시등만 도는 상태로 답이 다 끝날 때까지 기다리게 된다 — 먹은 건지 아닌지
  // 알 수 없으니 같은 말을 한 번 더 보내게 되는 자리다.
  //
  // 그래서 보낸 글을 실행 스트림에 한 번 흘린다. 실행 버퍼에 남으므로 조금 뒤에
  // 구독하는 화면도 이 줄부터 따라온다. `local_` 로 시작하는 id 는 "기록이
  // 따라잡으면 이 줄을 지워라"는 표시다 — 잠시 뒤 REST 기록이 같은 턴을
  // 돌려주면 화면이 이 임시 줄을 알아서 걷어낸다.
  if (!ws && command.trim()) {
    run.writer.send(createNormalizedMessage({
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: 'text',
      role: 'user',
      content: command,
      sessionId,
      provider,
      // 밖에서 들어온 글이라는 표시. 기록을 나중에 볼 때 붙는 배지와 같은 것을
      // 지금 바로 보여준다.
      ...(origin === 'telegram' ? { source: 'telegram' as const } : {}),
    }));
  }

  let failure: string | null = null;
  try {
    // Runs only now that the session is reserved, because an edit rewinds the
    // conversation here and a rewind for a run that was never admitted cannot
    // be taken back. Inside the try so a rewind that throws still releases the
    // run instead of leaving the session processing forever.
    await beforeRun?.(run);
    await dependencies.runtime.run(provider, command, runtimeOptions, run.writer);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[Chat] Provider runtime "${provider}" failed`, { sessionId, error: failure });
  } finally {
    // Safety net: a runtime that crashed (or resolved) without emitting its
    // terminal `complete` would otherwise leave the session stuck in
    // "processing" forever on every connected client. Scoped to THIS run —
    // a queued message can start the session's next run before this promise
    // settles, and the session-keyed completeRun would kill that new run.
    chatRunRegistry.completeRunIfCurrent(run, { exitCode: 1 });
  }

  return { started: true, error: failure };
}

/**
 * Handles `chat.edit-send`: replaces an already-sent message and everything
 * after it with a new turn.
 *
 * Nothing is deleted. The provider resumes the conversation partway and
 * appends the replacement, so the abandoned attempt stays in the transcript
 * file and is simply no longer part of the live conversation — the same shape
 * Claude Code's rewind and Codex's fork-with-cut-point produce.
 */
async function handleChatEditSend(
  ws: WebSocket,
  userId: string | number | null,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const resolved = resolveSendTarget(ws, data, dependencies, 'chat.edit-send');
  if (!resolved) {
    return;
  }

  const { sessionId, session, provider } = resolved;
  const anchorId = typeof data.anchorId === 'string' ? data.anchorId.trim() : '';
  if (!anchorId) {
    sendProtocolError(ws, 'ANCHOR_REQUIRED', 'chat.edit-send requires the anchorId of the message being replaced.', sessionId);
    return;
  }

  let resumeThroughId: string | null;
  try {
    const anchor = await sessionsService.resolveEditAnchor(sessionId, anchorId);
    if (!anchor) {
      sendProtocolError(
        ws,
        'EDIT_NOT_SUPPORTED',
        `Provider "${provider}" cannot replace an already-sent message.`,
        sessionId
      );
      return;
    }
    if (!anchor.found) {
      sendProtocolError(ws, 'ANCHOR_NOT_FOUND', 'That message is no longer in the transcript.', sessionId);
      return;
    }
    resumeThroughId = anchor.resumeThroughId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendProtocolError(ws, 'ANCHOR_LOOKUP_FAILED', `Could not read the transcript: ${message}`, sessionId);
    return;
  }

  // Providers split here on what their runtime can do. Claude resumes its
  // transcript partway, so the anchor rides along as a run option. Codex
  // cannot — a thread only grows — so the conversation is rewound on disk and
  // the run that follows is an ordinary resume of whatever the session then
  // points at. Which of the two applies is decided here; the rewind itself
  // waits until the run has actually been admitted.
  const rewinds = sessionsService.providerRewindsForEdit(sessionId);

  await dispatchRun(
    ws,
    userId,
    sessionId,
    session,
    data,
    dependencies,
    // `null` is meaningful: the edited turn was the first prompt, so the
    // conversation starts over instead of resuming.
    rewinds
      ? {}
      : { resumeAnchorId: resumeThroughId ?? undefined, resumeFromScratch: resumeThroughId === null },
    async (run) => {
      // Emitted through the run's writer so it is sequenced and replayed like
      // any other event — a second tab watching this session has to truncate
      // too.
      //
      // Before the rewind, not after it. A rewind that has to branch spawns a
      // process and waits on a JSON-RPC round trip, and holding the frame
      // until that came back left the message the user had just edited away
      // sitting on screen for about a second — the very flicker this feature
      // exists to avoid. Announcing first is safe because a rewind that fails
      // still ends the run, and the terminal `complete` makes every client
      // re-read the transcript, which puts back anything that turned out not
      // to have been replaced after all.
      run.writer.send({
        kind: 'history_truncated',
        provider,
        sessionId,
        anchorId,
      });

      if (rewinds) {
        try {
          await sessionsService.rewindSessionForEdit(sessionId, resumeThroughId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendProtocolError(ws, 'EDIT_REWIND_FAILED', `Could not rewind the conversation: ${message}`, sessionId);
          // Ends the run before the provider is asked to continue a
          // conversation that was not rewound after all.
          throw error;
        }
      }
    },
  );
}

/**
 * Handles `chat.abort`: cancels the run for one app session and emits the
 * terminal `complete` on its behalf (runtimes skip their own complete for
 * aborted runs, and the registry drops any duplicate).
 */
async function handleChatAbort(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): Promise<void> {
  const sessionId = readRequiredSessionId(data);
  if (!sessionId) {
    sendProtocolError(ws, 'SESSION_ID_REQUIRED', 'chat.abort requires a sessionId.');
    return;
  }

  const run = chatRunRegistry.getRun(sessionId);
  if (!run || run.status !== 'running') {
    sendProtocolError(ws, 'NO_ACTIVE_RUN', `Session "${sessionId}" has no active run.`, sessionId);
    return;
  }

  const success = await dependencies.runtime.abort(run.provider, sessionId);

  chatRunRegistry.completeRun(sessionId, {
    exitCode: success ? 0 : 1,
    aborted: true,
  });
}

/**
 * Handles `chat.subscribe`: for each requested session, reports whether a run
 * is processing, re-attaches the live stream to this socket, replays missed
 * events (seq > lastSeq), and includes pending permission requests.
 *
 * This single message replaces the old `check-session-status`,
 * `get-pending-permissions`, and Claude-only writer reconnect flows.
 */
function handleChatSubscribe(
  ws: WebSocket,
  data: AnyRecord,
  dependencies: ChatWebSocketDependencies
): void {
  const targets = Array.isArray(data.sessions) ? data.sessions : [];

  for (const target of targets) {
    if (!target || typeof target !== 'object') {
      continue;
    }

    const sessionId = typeof (target as AnyRecord).sessionId === 'string'
      ? ((target as AnyRecord).sessionId as string).trim()
      : '';
    if (!sessionId) {
      continue;
    }

    const lastSeqRaw = (target as AnyRecord).lastSeq;
    const lastSeq = typeof lastSeqRaw === 'number' && Number.isFinite(lastSeqRaw)
      ? Math.max(0, Math.floor(lastSeqRaw))
      : 0;

    const run = chatRunRegistry.getRun(sessionId);
    const isProcessing = chatRunRegistry.isProcessing(sessionId);

    // `seq` 는 실행마다 1 부터 다시 센다. 그래서 클라이언트가 들고 온 값이 지금
    // 실행의 마지막 `seq` 보다 클 수 있다 — 이전 턴에서 올려 둔 값이다. 그대로
    // 믿으면 이번 턴의 이벤트가 전부 "이미 본 것"으로 걸러져, 화면은 표시등만
    // 돌고 내용은 새로 고칠 때까지 오지 않는다.
    const effectiveLastSeq = lastSeq > (run?.lastSeq ?? 0) ? 0 : lastSeq;

    // Future live events for this run should land on the socket that asked —
    // this is what makes mid-stream page refreshes work for all providers.
    if (isProcessing) {
      chatRunRegistry.attachConnection(sessionId, ws);
    }

    // Pending approvals are tracked under the app session id inside the
    // Claude runtime, so they can be looked up directly.
    const pendingPermissions = dependencies.runtime.getPendingApprovalsForSession(sessionId);

    sendJson(ws, {
      kind: 'chat_subscribed',
      sessionId,
      isProcessing,
      lastSeq: run?.lastSeq ?? 0,
      pendingPermissions,
      timestamp: new Date().toISOString(),
    });

    // Replay only for RUNNING runs, strictly after the ack. Completed runs
    // are fully persisted to the provider transcript and served over REST —
    // replaying them (e.g. after a page reload where the client's lastSeq is
    // 0) would duplicate messages the history fetch already returned.
    if (isProcessing) {
      for (const event of chatRunRegistry.replayEvents(sessionId, effectiveLastSeq)) {
        sendJson(ws, event);
      }
    }
  }
}

/**
 * Handles `chat.permission-response`: forwards a tool-approval decision to the
 * pending approval resolver (Claude is the only provider with interactive
 * approvals today, but the message is intentionally provider-neutral).
 */
function handlePermissionResponse(data: AnyRecord, dependencies: ChatWebSocketDependencies): void {
  if (typeof data.requestId !== 'string' || data.requestId.length === 0) {
    return;
  }

  dependencies.runtime.resolveToolApproval(data.requestId, {
    allow: Boolean(data.allow),
    updatedInput: data.updatedInput,
    message: typeof data.message === 'string' ? data.message : undefined,
    rememberEntry: data.rememberEntry,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 *
 * Inbound protocol (client to server):
 * - `chat.send`                { sessionId, content, options? }
 * - `chat.abort`               { sessionId }
 * - `chat.subscribe`           { sessions: [{ sessionId, lastSeq? }] }
 * - `chat.permission-response` { requestId, allow, updatedInput?, message?, rememberEntry? }
 *
 * Outbound protocol (server to client): every frame is `kind`-based — either
 * a provider `NormalizedMessage` (with `seq`) or a gateway event
 * (`chat_subscribed`, `session_upserted`, `loading_progress`,
 * `protocol_error`).
 */
/**
 * Runs a turn for a session with no client attached.
 *
 * Used by scheduled messages, which fire from a timer: there is no socket to
 * report errors to and no audience to stream to. The run is registered exactly
 * like an interactive one, so anyone who opens the session while it is going
 * subscribes and replays it from the start, and the session shows as busy
 * everywhere in the meantime.
 *
 * Resolves when the provider run settles. Returns false when the session has
 * gone away or is busy without `interruptActiveRun`, which the caller reports
 * on the schedule.
 */
export async function runDetachedChatTurn(
  input: {
    sessionId: string;
    userId: string | number | null;
    content: string;
    options?: AnyRecord;
    /**
     * Aborts a run already in progress instead of refusing to start. A
     * scheduled message sets this: the user picked the time knowing it might
     * land mid-run, so the timer outranks whatever is running.
     */
    interruptActiveRun?: boolean;
    /**
     * 이 턴을 누가 시작시켰는지. 텔레그램에서 온 것만 `telegram` 이고, 예약·
     * 대기열처럼 타이머가 미는 것은 기본값 `web` 이다 — 사람이 텔레그램에서
     * 답을 기다리고 있는 실행만 무조건 회신하기 위해서다.
     */
    origin?: ChatRunOrigin;
  },
  dependencies: ChatWebSocketDependencies,
): Promise<{ started: boolean; error: string | null }> {
  const session = sessionsDb.getSessionById(input.sessionId);
  if (!session) {
    return { started: false, error: 'The session no longer exists.' };
  }

  const provider = session.provider as LLMProvider;
  if (!dependencies.runtime.hasRuntime(provider)) {
    return { started: false, error: `Provider "${provider}" is not available.` };
  }

  const activeRun = chatRunRegistry.getRun(input.sessionId);
  if (activeRun && activeRun.status === 'running') {
    if (!input.interruptActiveRun) {
      return { started: false, error: 'A run was already in progress for this session.' };
    }
    // Same shape as `chat.abort`: cancel the provider run and emit the
    // terminal `complete` on its behalf, so every watching client sees the
    // interrupted run end before this turn's stream begins. The interrupted
    // run's own dispatch settles later through completeRunIfCurrent, which is
    // scoped to that run and cannot touch the one started here.
    const aborted = await dependencies.runtime.abort(activeRun.provider, input.sessionId);
    chatRunRegistry.completeRun(input.sessionId, {
      exitCode: aborted ? 0 : 1,
      aborted: true,
    });
  }

  return dispatchRun(
    null,
    input.userId,
    input.sessionId,
    session,
    { sessionId: input.sessionId, content: input.content, options: input.options ?? {} },
    dependencies,
    {},
    undefined,
    input.origin ?? 'web',
  );
}

export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const userId = readRequestUserId(request);

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as AnyRecord;
      const messageType = typeof data.type === 'string' ? data.type : '';

      switch (messageType) {
        case 'chat.edit-send':
          await handleChatEditSend(ws, userId, data, dependencies);
          return;
        case 'chat.send':
          await handleChatSend(ws, userId, data, dependencies);
          return;
        case 'chat.abort':
          await handleChatAbort(ws, data, dependencies);
          return;
        case 'chat.subscribe':
          handleChatSubscribe(ws, data, dependencies);
          return;
        case 'chat.permission-response':
          handlePermissionResponse(data, dependencies);
          return;
        default:
          sendProtocolError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type "${messageType}".`);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      sendProtocolError(ws, 'INTERNAL_ERROR', message);
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
  });
}
