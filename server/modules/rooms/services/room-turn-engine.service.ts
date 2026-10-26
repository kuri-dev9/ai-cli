import { roomsDb, sessionsDb } from '@/modules/database/index.js';
import type { RoomRow } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { isSessionHandedToTelegram } from '@/modules/telegram-bridge/index.js';
import {
  chatRunRegistry,
  resolveTelegramRunPermissions,
  runDetachedChatTurn,
  TELEGRAM_READ_ONLY_TOOLS,
} from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { broadcastRoomFrame } from '@/modules/rooms/services/room-broadcast.service.js';
import {
  buildTurnPrompt,
  nextParticipantAfter,
  parseAssignments,
  parseHandoff,
  pickSpeakerForUserMessage,
} from '@/modules/rooms/services/room-prompt.service.js';
import type { RoomHandoff, RoomTurnMode } from '@/modules/rooms/services/room-prompt.service.js';
import {
  parseRoomPermissionMode,
  serializeHandoff,
  toRoomMessage,
  toRoomParticipant,
} from '@/modules/rooms/services/room-records.service.js';
import type {
  AnyRecord,
  NormalizedMessage,
  RoomAttachment,
  RoomMessage,
  RoomParticipant,
  RoomPhase,
  RoomRuntimeState,
  RoomTask,
  RoomTurnKind,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * 룸의 차례를 돌린다.
 *
 * 보통은 한 번에 한 참가자가 답하고, 마지막 줄의 넘김 표시대로 다음 참가자가
 * 이어받는다. 룸 설정에 따라 두 가지가 더해진다.
 *
 * - 분담(split_work): 답에 `[작업 @이름] 할 일` 줄이 있으면 맡은 참가자들이
 *   동시에 일하고, 모두 끝나면 맡긴 참가자가 결과를 모아 정리한다. 같은 폴더를
 *   쓰므로 동시에 일하는 동안 파일을 고칠 수 있는 건 `수정` 을 맡은 한 명뿐이고,
 *   나머지는 읽기 전용으로 돈다.
 * - 의견(discussion): 한 참가자의 답이 올라올 때마다 나머지가 동시에 짧게
 *   의견을 낸다. 보탤 말이 없으면 `[PASS]` 로 넘어가고, 그 답은 남기지 않는다.
 *
 * 사용자는 언제든 글을 보낼 수 있고, 그 글은 바로 타임라인에 올라간 뒤 지금
 * 일하는 참가자들이 끝나는 대로 반영된다. [지금 끼어들기]는 그들을 끊는다.
 *
 * 상태는 메모리에만 있다. 서버가 다시 뜨면 모든 룸은 쉬는 상태로 돌아가고,
 * 타임라인은 DB 에 남아 있으므로 사용자가 다시 말을 걸면 이어진다.
 */

type RoomLoopState = {
  running: boolean;
  /** 정지 버튼. 새 사용자 메시지가 오면 풀린다. */
  halted: boolean;
  /** 지금 일하는 참가자 → 그 세션. 분담 중이면 여럿이다. */
  active: Map<string, string>;
  phase: RoomPhase;
  turnCount: number;
  /** 차례가 도는 중에 사용자가 보낸 글이 있다. 다음 차례 경계에서 처리한다. */
  pendingUserMessage: boolean;
  /**
   * 사용자가 끼어들어 끊은 세션. 그 답은 실패가 아니라 중단으로 남기고, 루프는
   * 멈추지 않은 채 기다리던 글로 넘어간다.
   */
  interruptedSessions: Set<string>;
  /** 마지막으로 글을 보낸 사용자. 참가자 턴을 그 사용자 이름으로 돌린다. */
  userId: string | number | null;
};

type TurnResult = {
  /** 타임라인에 올린 답. 의견 차례가 보탤 말 없이 끝나면 아무것도 올리지 않아 null 이다. */
  message: RoomMessage | null;
  handoff: RoomHandoff;
  /** 이 답이 나눠 맡긴 일. 분담이 꺼져 있거나 맡긴 게 없으면 비어 있다. */
  assignments: Array<{ participantId: string; task: RoomTask }>;
};

type TurnOptions = {
  mode: RoomTurnMode;
  /** 동시에 일하는 동안 파일을 고치지 못하게 한다. */
  readOnly: boolean;
  /** 이 답의 종류. 타임라인 카드가 이것으로 갈린다. */
  turnKind: RoomTurnKind;
  /** 분담이 켜져 있어 답에서 맡긴 일을 읽을지. */
  readAssignments: boolean;
  /** `[PASS]` 뿐인 답은 타임라인에 남기지 않는다(의견 차례). */
  dropPass: boolean;
};

const loops = new Map<string, RoomLoopState>();
let runtime: ProviderRuntimeGateway | null = null;

/** 원래 대화에서 새 참가자에게 넘길 최근 메시지 수와 길이. */
const PRIOR_CONTEXT_MESSAGES = 12;
const PRIOR_CONTEXT_MESSAGE_CHARS = 800;

/** 읽기 전용 차례에서 막는 Claude 도구. 같은 폴더를 동시에 고치지 않게 한다. */
const CLAUDE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function getLoop(roomId: string): RoomLoopState {
  let loop = loops.get(roomId);
  if (!loop) {
    loop = {
      running: false,
      halted: false,
      active: new Map(),
      phase: 'idle',
      turnCount: 0,
      pendingUserMessage: false,
      interruptedSessions: new Set(),
      userId: null,
    };
    loops.set(roomId, loop);
  }
  return loop;
}

function readState(roomId: string, maxAutoTurns: number): RoomRuntimeState {
  const loop = loops.get(roomId);
  const participantIds = loop ? [...loop.active.keys()] : [];
  const sessionIds = loop ? [...loop.active.values()] : [];
  return {
    status: loop?.running ? 'running' : 'idle',
    activeParticipantId: participantIds[0] ?? null,
    activeSessionId: sessionIds[0] ?? null,
    activeParticipantIds: participantIds,
    activeSessionIds: sessionIds,
    phase: loop?.running ? loop.phase : 'idle',
    turnCount: loop?.turnCount ?? 0,
    maxAutoTurns,
    pendingUserMessage: loop?.pendingUserMessage ?? false,
  };
}

function broadcastState(room: RoomRow): void {
  broadcastRoomFrame({ kind: 'room_state', roomId: room.room_id, state: readState(room.room_id, room.max_auto_turns) });
}

function loadParticipants(room: RoomRow): RoomParticipant[] {
  return roomsDb.listParticipants(room.room_id).map((row) => toRoomParticipant(row, room));
}

/**
 * 이 턴이 남긴 답. 도구 사이사이 남긴 말까지 이어서 타임라인에 올리고, 넘김
 * 표시는 마지막 말에서만 읽는다. 스트리밍 조각은 확정된 `text` 와 내용이
 * 겹치므로 보지 않는다.
 */
function readTurnTexts(sessionId: string): { all: string; last: string; errors: string[] } {
  const events = chatRunRegistry.replayEvents(sessionId, 0) as NormalizedMessage[];
  const texts = events
    .filter((event) => event.kind === 'text' && event.role === 'assistant' && event.content?.trim())
    .map((event) => event.content!.trim());
  const errors = events
    .filter((event) => event.kind === 'error' && event.content?.trim())
    .map((event) => event.content!.trim());
  return { all: texts.join('\n\n'), last: texts.at(-1) ?? '', errors };
}

/**
 * 새로 초대된 참가자를 위한 원래 대화의 끝부분. 룸이 된 뒤의 대화는 룸
 * 타임라인으로 따로 넘기므로, 룸이 만들어지기 전 것만 쓴다.
 */
async function readPriorContext(room: RoomRow): Promise<string | null> {
  try {
    const history = await sessionsService.fetchHistory(room.host_session_id, { limit: 60 });
    const roomCreatedAt = Date.parse(`${room.created_at.replace(' ', 'T')}Z`);
    const lines = history.messages
      .filter((message) => message.kind === 'text' && (message.role === 'user' || message.role === 'assistant'))
      .filter((message) => message.content?.trim())
      .filter((message) => {
        const at = Date.parse(message.timestamp);
        return !Number.isFinite(roomCreatedAt) || !Number.isFinite(at) || at < roomCreatedAt;
      })
      .slice(-PRIOR_CONTEXT_MESSAGES)
      .map((message) => {
        const content = message.content!.trim();
        const clipped = content.length > PRIOR_CONTEXT_MESSAGE_CHARS
          ? `${content.slice(0, PRIOR_CONTEXT_MESSAGE_CHARS)}…`
          : content;
        return `[${message.role === 'user' ? '사용자' : '원래 대화의 AI'}] ${clipped}`;
      });
    return lines.length ? lines.join('\n') : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[Rooms] Could not read the host conversation for a new participant', { error: message });
    return null;
  }
}

/**
 * 이 차례에 쓰는 권한. 읽기 전용 차례는 참가자 설정과 상관없이 파일을 고치지
 * 못한다 — Claude 는 쓰기 도구를 막고, Codex 는 읽기 전용 샌드박스로 돈다.
 * 다른 프로바이더는 막을 수단이 없어 읽기 프리셋과 안내문에 맡긴다.
 */
function resolveTurnPermissions(me: RoomParticipant, readOnly: boolean): AnyRecord {
  if (!readOnly) {
    return resolveTelegramRunPermissions(parseRoomPermissionMode(me.permissionMode));
  }
  if (me.provider === 'codex') {
    return { permissionMode: 'readOnly' };
  }
  return {
    toolsSettings: {
      allowedTools: [...TELEGRAM_READ_ONLY_TOOLS],
      disallowedTools: me.provider === 'claude' ? [...CLAUDE_WRITE_TOOLS] : [],
      skipPermissions: false,
    },
  };
}

async function runParticipantTurn(room: RoomRow, me: RoomParticipant, loop: RoomLoopState, options: TurnOptions): Promise<TurnResult> {
  if (!runtime) {
    throw new Error('Room engine is not initialized.');
  }

  const participants = loadParticipants(room);
  const meRow = roomsDb.listParticipants(room.room_id).find((row) => row.participant_id === me.participantId);
  const lastSeen = meRow?.last_seen_message_id ?? 0;
  const unread = roomsDb.listMessagesAfter(room.room_id, lastSeen).map(toRoomMessage);
  // 자기 답은 이미 자기 세션에 있다.
  const delta = unread.filter((message) => message.speaker !== me.participantId);
  const isFirstTurn = lastSeen === 0 && !unread.some((message) => message.speaker === me.participantId);
  const priorContext = isFirstTurn && !me.isHost ? await readPriorContext(room) : null;
  const readThroughId = unread.at(-1)?.id ?? lastSeen;

  const prompt = buildTurnPrompt({ me, participants, delta, isFirstTurn, priorContext, mode: options.mode });
  // 사용자가 그동안 붙인 파일. 참가자마다 자기가 아직 못 본 글의 것만 받는다.
  const attachments = delta.filter((message) => message.speaker === 'user').flatMap((message) => message.attachments);

  try {
    const result = await runTurnInSession(room, me, loop, prompt, attachments, options.readOnly);

    // 이 차례에 보낸 데까지는 읽은 것이다. 일하는 동안 들어온 사용자 글은 그 뒤에
    // 있으므로 다음 차례에 간다.
    roomsDb.markParticipantSeen(me.participantId, readThroughId);

    return recordTurnReply(room, me, loop, result, {
      ...options,
      task: options.mode.kind === 'task' ? options.mode.task : undefined,
    });
  } finally {
    finishActiveTurn(room, me, loop);
  }
}

/**
 * 일하는 중 표시를 내린다. 답을 타임라인에 올린 뒤에 부른다 — 화면은 이 참가자가
 * 목록에서 빠지는 것을 보고 실시간 출력을 닫으므로, 답보다 먼저 빠지면 그 사이
 * 출력이 사라졌다가 답이 뒤늦게 나타난다.
 */
function finishActiveTurn(room: RoomRow, me: RoomParticipant, loop: RoomLoopState): void {
  loop.active.delete(me.participantId);
  broadcastState(room);
}

/**
 * 참가자 세션에서 한 차례를 돌린다. 모델과 추론 강도는 그 세션에 적힌 것을
 * 먼저 쓴다 — 참가자 설정에서 바꾼 값이 세션에 적히고, 여기서 초대할 때의
 * 값을 다시 실으면 실행이 그 값으로 되돌려 적어 버린다.
 */
async function runTurnInSession(
  room: RoomRow,
  me: RoomParticipant,
  loop: RoomLoopState,
  content: string,
  attachments: RoomAttachment[],
  readOnly: boolean,
): Promise<{ started: boolean; error: string | null }> {
  if (!runtime) {
    throw new Error('Room engine is not initialized.');
  }
  // 앞 차례 끝에 늦게 닿은 끼어들기 표시가 이 차례를 중단으로 만들지 않게 한다.
  loop.interruptedSessions.delete(me.sessionId);
  loop.active.set(me.participantId, me.sessionId);
  broadcastState(room);

  const session = sessionsDb.getSessionById(me.sessionId);
  const model = session?.model || me.model;
  const effort = session?.effort;
  return runDetachedChatTurn(
    {
      sessionId: me.sessionId,
      userId: loop.userId,
      content,
      options: {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...resolveTurnPermissions(me, readOnly),
      },
    },
    { runtime, isSessionHandedToTelegram },
  );
}

/** `[PASS]` 한 줄뿐인 답인지. 의견 차례에서 보탤 말이 없다는 뜻이다. */
function isOnlyPass(text: string): boolean {
  return /^\s*\[PASS\]\s*$/iu.test(text);
}

/** 끝난 차례의 답을 타임라인에 올린다. 의견 차례의 `[PASS]` 는 올리지 않는다. */
function recordTurnReply(
  room: RoomRow,
  me: RoomParticipant,
  loop: RoomLoopState,
  result: { started: boolean; error: string | null },
  options: Pick<TurnOptions, 'turnKind' | 'readAssignments' | 'dropPass'> & { task?: RoomTask },
): TurnResult {
  const texts = result.started ? readTurnTexts(me.sessionId) : { all: '', last: '', errors: [] };
  let status: RoomMessage['status'] = 'complete';
  let text = texts.all;
  if (loop.halted || loop.interruptedSessions.has(me.sessionId)) {
    loop.interruptedSessions.delete(me.sessionId);
    status = 'aborted';
    text = text || '(중단됨)';
  } else if (!result.started || result.error || (!text && texts.errors.length)) {
    status = 'error';
    text = text || `(실행 실패) ${result.error ?? texts.errors.join('\n') ?? ''}`.trim();
  } else if (!text) {
    text = '(응답 없음)';
  }

  const participants = loadParticipants(room);
  // 넘김 표시와 맡긴 일은 끝까지 해낸 답에서만 읽는다. 끊기거나 실패한 답은 뜻이 없다.
  const handoff: RoomHandoff = status === 'complete'
    ? parseHandoff(texts.last, participants, me.participantId)
    : { kind: 'none' };
  const assignments = status === 'complete' && options.readAssignments
    ? parseAssignments(texts.all, participants)
    : [];

  // 의견 차례는 보탤 말이 없거나 실패했으면 흔적을 남기지 않는다. 의견은 덧붙임이라
  // 빠져도 흐름이 끊기지 않는다.
  if (options.dropPass && (status !== 'complete' || isOnlyPass(text))) {
    return { message: null, handoff, assignments: [] };
  }

  const turnKind: RoomTurnKind = assignments.length > 0 ? 'plan' : options.turnKind;
  const row = roomsDb.insertMessage({
    roomId: room.room_id,
    speaker: me.participantId,
    text,
    status,
    sessionId: me.sessionId,
    finalText: texts.last || null,
    handoff: assignments.length > 0 ? null : serializeHandoff(handoff.kind === 'none' ? null : handoff),
    turnKind,
    task: options.task ? JSON.stringify(options.task) : null,
  });
  const message = toRoomMessage(row);
  broadcastRoomFrame({ kind: 'room_message', roomId: room.room_id, message });
  return { message, handoff, assignments };
}

function latestUserMessageText(roomId: string): string {
  const messages = roomsDb.listMessages(roomId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].speaker === 'user') {
      return messages[index].text;
    }
  }
  return '';
}

/** 분담이 켜져 있는지. 혼자 남은 룸에서는 나눌 상대가 없다. */
function canSplitWork(room: RoomRow, participants: RoomParticipant[]): boolean {
  return room.split_work !== 0 && participants.length > 1;
}

/**
 * 맡긴 일을 동시에 돌린다. 각자 끝나는 대로 타임라인에 올라간다. `canEdit`
 * 이 아닌 참가자는 읽기 전용이다.
 */
async function runAssignments(
  room: RoomRow,
  lead: RoomParticipant,
  assignments: TurnResult['assignments'],
  loop: RoomLoopState,
): Promise<void> {
  const participants = loadParticipants(room);
  loop.phase = 'working';
  await Promise.all(assignments.map(async ({ participantId, task }) => {
    const assignee = participants.find((participant) => participant.participantId === participantId);
    if (!assignee) return;
    // 혼자 맡은 일이면 막을 이유가 없다. 여럿이 동시에 돌 때만 수정을 한 명으로 줄인다.
    const readOnly = assignments.length > 1 && !task.canEdit;
    await runParticipantTurn(room, assignee, loop, {
      mode: { kind: 'task', task: { ...task, canEdit: !readOnly }, leadName: lead.displayName },
      readOnly,
      turnKind: 'task',
      readAssignments: false,
      dropPass: false,
    });
  }));
}

/** 방금 올라온 답에 나머지 참가자가 동시에 짧게 의견을 낸다. 모두 읽기 전용이다. */
async function runCommentRound(room: RoomRow, speaker: RoomParticipant, loop: RoomLoopState): Promise<void> {
  const others = loadParticipants(room).filter((participant) => participant.participantId !== speaker.participantId);
  if (others.length === 0) return;
  loop.phase = 'discussing';
  await Promise.all(others.map((participant) => runParticipantTurn(room, participant, loop, {
    mode: { kind: 'comment', onName: speaker.displayName },
    readOnly: true,
    turnKind: 'comment',
    readAssignments: false,
    dropPass: true,
  })));
}

/**
 * 사용자 메시지 하나로 시작해, 참가자들이 넘김 표시대로 차례를 주고받는다.
 * 분담이 켜져 있으면 답이 맡긴 일을 동시에 돌리고 맡긴 참가자가 정리하며,
 * 의견이 켜져 있으면 답마다 나머지가 의견을 낸다.
 *
 * 끝나는 경우: `[DONE]`, 다른 참가자 모두가 연달아 `[PASS]`, 자동 턴 한도,
 * 정지, 실행 실패. 실패에서 멈추는 이유는 다음 참가자가 실패한 답을 받아
 * 엉뚱하게 이어가기 쉬워서다 — 사용자가 보고 다시 시키는 편이 낫다.
 * 자동 턴은 차례 하나, 분담 한 번(동시에 몇 명이 일하든)을 각각 하나로 센다.
 */
async function runLoop(roomId: string): Promise<void> {
  const loop = getLoop(roomId);
  loop.running = true;

  try {
    let next: RoomParticipant | null = null;
    // 다음 차례가 무엇인지: 사용자 글에 대한 첫 답, 보통의 차례, 맡긴 일의 정리.
    let nextKind: 'opening' | 'turn' | 'summary' = 'turn';
    let consecutivePasses = 0;

    while (!loop.halted) {
      const room = roomsDb.getRoom(roomId);
      if (!room) {
        break;
      }
      const participants = loadParticipants(room);

      if (loop.pendingUserMessage) {
        // 사용자의 새 글이 이어지던 흐름보다 우선한다. 한도도 새로 센다.
        loop.pendingUserMessage = false;
        loop.turnCount = 0;
        consecutivePasses = 0;
        next = pickSpeakerForUserMessage(latestUserMessageText(roomId), participants);
        nextKind = 'opening';
      }

      if (!next || loop.turnCount >= room.max_auto_turns) {
        break;
      }

      const speaker: RoomParticipant | undefined = participants.find((participant) => participant.participantId === next!.participantId);
      if (!speaker) {
        break;
      }

      const splitting = canSplitWork(room, participants);
      loop.phase = nextKind === 'summary' ? 'summarizing' : 'turn';
      const mode: RoomTurnMode = nextKind === 'summary'
        ? { kind: 'summary' }
        : nextKind === 'opening' && splitting ? { kind: 'plan' } : { kind: 'turn' };
      const { message, handoff, assignments } = await runParticipantTurn(room, speaker, loop, {
        mode,
        readOnly: false,
        turnKind: nextKind === 'summary' ? 'summary' : 'reply',
        readAssignments: splitting,
        dropPass: false,
      });
      loop.turnCount += 1;
      broadcastState(room);

      if (loop.halted) {
        break;
      }
      if (loop.pendingUserMessage) {
        continue;
      }
      if (!message || message.status !== 'complete') {
        break;
      }

      if (assignments.length > 0) {
        if (loop.turnCount >= room.max_auto_turns) {
          break;
        }
        await runAssignments(room, speaker, assignments, loop);
        loop.turnCount += 1;
        broadcastState(room);
        if (loop.halted) {
          break;
        }
        if (loop.pendingUserMessage) {
          continue;
        }
        // 결과는 맡긴 참가자가 모아 정리한다.
        consecutivePasses = 0;
        next = speaker;
        nextKind = 'summary';
        continue;
      }

      if (room.discussion !== 0 && participants.length > 1 && handoff.kind !== 'pass') {
        await runCommentRound(room, speaker, loop);
        broadcastState(room);
        if (loop.halted) {
          break;
        }
        if (loop.pendingUserMessage) {
          continue;
        }
      }

      nextKind = 'turn';
      if (handoff.kind === 'done') {
        break;
      }
      if (handoff.kind === 'mention') {
        consecutivePasses = 0;
        next = participants.find((participant) => participant.participantId === handoff.participantId) ?? null;
        continue;
      }
      if (handoff.kind === 'pass') {
        consecutivePasses += 1;
        if (consecutivePasses >= participants.length - 1) {
          break;
        }
      } else {
        consecutivePasses = 0;
      }
      next = nextParticipantAfter(participants, speaker.participantId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Rooms] Room loop failed', { roomId, error: message });
  } finally {
    loop.running = false;
    loop.active.clear();
    loop.phase = 'idle';
    const room = roomsDb.getRoom(roomId);
    if (room) {
      broadcastState(room);
    }
    // 마지막 차례가 끝나는 순간 들어온 글이 있으면 다시 돈다.
    if (loop.pendingUserMessage && !loop.halted && room) {
      void runLoop(roomId);
    }
  }
}

/**
 * 지금 일하는 참가자 모두의 실행을 끊는다. 런타임은 끊긴 실행에 `complete` 를
 * 내지 않으므로 여기서 대신 낸다. `markInterrupted` 면 그 답들을 중단으로 남긴다.
 */
async function abortActiveRuns(loop: RoomLoopState, markInterrupted: boolean): Promise<void> {
  await Promise.all([...loop.active.values()].map(async (sessionId) => {
    const run = chatRunRegistry.getRun(sessionId);
    if (!run || run.status !== 'running' || !runtime) return;
    if (markInterrupted) loop.interruptedSessions.add(sessionId);
    // `chat.abort` 와 같은 모양이다.
    const aborted = await runtime.abort(run.provider, sessionId);
    chatRunRegistry.completeRun(sessionId, { exitCode: aborted ? 0 : 1, aborted: true });
  }));
}

/**
 * 호스트 세션에서 명령 하나를 그대로 돌린다. 룸 안내문으로 감싸면 `/compact`
 * 같은 명령이 명령으로 읽히지 않으므로 사용자가 쓴 그대로 보낸다. 답은
 * 타임라인에 호스트 발언으로 남고, 다른 참가자에게 넘기지 않는다.
 */
async function runHostCommand(roomId: string, commandMessageId: number, content: string, attachments: RoomAttachment[]): Promise<void> {
  const loop = getLoop(roomId);
  loop.running = true;
  loop.phase = 'turn';
  try {
    const room = roomsDb.getRoom(roomId);
    const host = room ? loadParticipants(room).find((participant) => participant.isHost) : undefined;
    if (!room || !host) {
      return;
    }
    const lastSeenBefore = roomsDb.listParticipants(roomId).find((row) => row.participant_id === host.participantId)?.last_seen_message_id ?? 0;
    // 명령 앞에 호스트가 아직 못 본 다른 글이 없으면, 명령과 그 답까지 읽은 것으로 친다.
    // 남아 있으면 그대로 두어 다음 차례에 함께 받게 한다.
    const unreadBefore = roomsDb.listMessagesAfter(roomId, lastSeenBefore).filter((row) => row.id < commandMessageId);

    const result = await runTurnInSession(room, host, loop, content, attachments, false);
    const { message } = recordTurnReply(room, host, loop, result, { turnKind: 'reply', readAssignments: false, dropPass: false });
    if (message && unreadBefore.length === 0) {
      roomsDb.markParticipantSeen(host.participantId, message.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Rooms] Host command failed', { roomId, error: message });
  } finally {
    loop.running = false;
    loop.active.clear();
    loop.phase = 'idle';
    const room = roomsDb.getRoom(roomId);
    if (room) {
      broadcastState(room);
    }
    // 명령이 도는 동안 보낸 글은 여기서 이어받는다.
    if (loop.pendingUserMessage && !loop.halted && room) {
      void runLoop(roomId);
    }
  }
}

/** Rooms 모듈 안에서 룸 서비스가 쓰는 턴 엔진. */
export const roomTurnEngine = {
  initialize(gateway: ProviderRuntimeGateway): void {
    runtime = gateway;
  },

  close(): void {
    for (const loop of loops.values()) {
      loop.halted = true;
    }
    loops.clear();
    runtime = null;
  },

  getState(roomId: string, maxAutoTurns: number): RoomRuntimeState {
    return readState(roomId, maxAutoTurns);
  },

  /**
   * 사용자 글을 올린다. 쉬고 있으면 바로 차례를 시작하고, 돌고 있으면 다음
   * 차례 경계에서 반영되도록 표시만 해 둔다.
   */
  postUserMessage(
    room: RoomRow,
    content: string,
    userId: string | number | null,
    options: { attachments?: RoomAttachment[]; hostCommand?: boolean } = {},
  ): { message: RoomMessage; state: RoomRuntimeState } {
    const loop = getLoop(room.room_id);
    const attachments = options.attachments ?? [];
    // 명령은 호스트 세션 하나를 쓰므로, 다른 차례와 겹치면 받지 않는다.
    if (options.hostCommand && loop.running) {
      throw new AppError('참가자가 일하는 중에는 명령을 실행할 수 없습니다. 끝나거나 정지한 뒤 다시 보내 주세요.', {
        code: 'ROOM_BUSY',
        statusCode: 409,
      });
    }
    const row = roomsDb.insertMessage({
      roomId: room.room_id,
      speaker: 'user',
      text: content,
      status: 'complete',
      sessionId: null,
      attachments: attachments.length ? JSON.stringify(attachments) : null,
    });
    const message = toRoomMessage(row);
    broadcastRoomFrame({ kind: 'room_message', roomId: room.room_id, message });

    loop.userId = userId;
    loop.halted = false;
    if (options.hostCommand) {
      void runHostCommand(room.room_id, message.id, content, attachments);
    } else {
      loop.pendingUserMessage = true;
      if (!loop.running) {
        void runLoop(room.room_id);
      }
    }
    broadcastState(room);
    return { message, state: readState(room.room_id, room.max_auto_turns) };
  },

  /**
   * 기다리던 사용자 글이 있을 때 지금 일하는 참가자들을 끊고 그 글로 넘어간다.
   * 정지와 달리 루프는 멈추지 않고, 끊긴 답은 중단으로 남는다.
   */
  async interrupt(room: RoomRow): Promise<RoomRuntimeState> {
    const loop = getLoop(room.room_id);
    if (loop.running && loop.pendingUserMessage && loop.active.size > 0) {
      await abortActiveRuns(loop, true);
    }
    broadcastState(room);
    return readState(room.room_id, room.max_auto_turns);
  },

  /** 이 참가자가 지금 일하고 있는지. 퇴장은 일이 끝난 뒤에만 받는다. */
  isSpeaking(roomId: string, participantId: string): boolean {
    const loop = loops.get(roomId);
    return Boolean(loop?.running && loop.active.has(participantId));
  },

  /** 정지. 지금 일하는 참가자들의 실행을 끊고, 기다리던 글도 내려놓는다. */
  async stop(room: RoomRow): Promise<RoomRuntimeState> {
    const loop = getLoop(room.room_id);
    loop.halted = true;
    loop.pendingUserMessage = false;
    await abortActiveRuns(loop, false);
    broadcastState(room);
    return readState(room.room_id, room.max_auto_turns);
  },
};
