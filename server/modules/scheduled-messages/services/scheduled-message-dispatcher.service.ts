import { roomsDb, scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import { roomsService } from '@/modules/rooms/index.js';
import { scheduleFromSettledRun } from '@/modules/scheduled-messages/services/reply-schedules.service.js';
import { isSessionHandedToTelegram } from '@/modules/telegram-bridge/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ChatRunOrigin, ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * 아무 예약도 가깝지 않을 때 확인하는 간격. 대기열의 안전망이기도 하다.
 *
 * 예전에는 이 간격으로만 확인해서, 07:16 예약이 07:16:29 에야 나가는 일이
 * 흔했다 — 화면에는 "다음 07:16" 이 그대로 떠 있으니 한 분 늦게 도는 것처럼
 * 보였다. 지금은 다음 예약 시각과 다음 분의 시작 중 이른 쪽에 맞춰 깨어난다.
 */
const POLL_INTERVAL_MS = 30_000;
/** 타이머가 예약 시각보다 아주 조금 먼저 깨는 일을 막는 여유. */
const WAKE_SLACK_MS = 50;
/** 앞선 확인이 끝나지 않았을 때 다시 볼 간격. */
const IN_FLIGHT_RETRY_MS = 1_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let dispatcherRunning = false;
let dispatchInFlight = false;
let unsubscribeRunSettled: (() => void) | null = null;

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
  /**
   * 이 메시지를 대기열에 넣은 곳.
   *
   * 텔레그램에서 보낸 글이 작업 중이라 줄을 섰다면, 한참 뒤에 실행되더라도
   * 결과는 텔레그램으로 돌아가야 한다. 실행하는 시점에는 출처를 알 방법이
   * 없으므로 넣을 때 적힌 것을 그대로 들고 간다.
   */
  origin: ChatRunOrigin;
};

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  const origin: ChatRunOrigin = record.origin === 'telegram' ? 'telegram' : 'web';
  return { content, options, attachments, origin };
}

/**
 * Failures that will not get better by waiting.
 *
 * Everything else — above all "a run is already in progress", which is what a
 * lost race looks like — puts the turn back on the queue. Matching on the exact
 * sentence used to be how the race was detected, and it silently stopped
 * working: the race actually surfaces the run-reservation error
 * ("A run **is** already in progress…"), not the pre-check one
 * ("A run **was** already in progress…"), so a raced message was dropped
 * instead of retried. The check is inverted now — only a session or provider
 * that is gone for good is allowed to discard a message.
 *
 * Only a deleted session qualifies. An unavailable provider looks permanent but
 * is not — it comes back with a restart or a settings fix, and the queued turn
 * should still be there when it does.
 */
function isPermanentSendFailure(error: string | null): boolean {
  if (!error) {
    return false;
  }
  return /no longer exists/i.test(error);
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  let result: { started: boolean; error: string | null };
  try {
    result = await runDetachedChatTurn(
      {
        sessionId: candidate.sessionId,
        userId: candidate.userId,
        content: message.content,
        options: { ...message.options, attachments: message.attachments },
        origin: message.origin,
      },
      { runtime, isSessionHandedToTelegram },
    );
  } catch (error) {
    // A throw is not a verdict on the message. Put it back rather than lose
    // what the user typed.
    sessionDraftsDb.restoreQueuedMessage(candidate);
    const reason = error instanceof Error ? error.message : String(error);
    console.error('[QueuedMessages] Send threw; the turn was put back on the queue', {
      sessionId: candidate.sessionId,
      error: reason,
    });
    return;
  }

  if (!result.started) {
    if (!isPermanentSendFailure(result.error)) {
      sessionDraftsDb.restoreQueuedMessage(candidate);
      return;
    }

    // Kept out of the retry loop, but never dropped in silence: a message the
    // user queued and never saw run is exactly the thing worth a log line.
    console.error('[QueuedMessages] Dropped a queued turn that can never be sent', {
      sessionId: candidate.sessionId,
      error: result.error,
      preview: message.content.slice(0, 120),
    });
  }

  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Sends the next queued turn for every idle session (or just `sessionId`).
 *
 * One turn per session per pass. The rest follow as each run finishes, which
 * is what keeps a three-message queue running in the order it was typed.
 */
export async function dispatchQueuedMessages(
  runtime: ProviderRuntimeGateway,
  sessionId?: string,
): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages(sessionId);
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (chatRunRegistry.isProcessing(candidate.sessionId)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime);
  }));

  return claimed;
}

/** 예약이 룸을 가리키면 룸 메시지로 올린 글 앞에 붙는 표시. 사용자가 쓴 글과 구별된다. */
const ROOM_SCHEDULE_PREFIX = '⏰ 예약: ';

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  // 룸이 된 대화로 가는 예약은 그 세션 하나에 보내지 않고 룸에 올린다. 그래야
  // 이름을 부른 참가자가 받고, 룸이 일하는 중이면 그 차례 뒤로 줄을 선다.
  const room = roomsDb.getRoomByHostSession(row.session_id);
  if (room) {
    try {
      roomsService.postUserMessage(room.room_id, { content: `${ROOM_SCHEDULE_PREFIX}${row.content}` }, row.user_id);
    } catch (error) {
      scheduledMessagesDb.markFailed(row.id, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime, isSessionHandedToTelegram },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequential within a session — it can only hold one run at a time, and two
  // messages due for the same session must not race each other into it — but
  // parallel across sessions. Draining the whole list in one line meant a
  // single long turn held up every other session's due messages behind it,
  // and held the poll's in-flight flag for its entire duration.
  const bySession = new Map<string, ScheduledMessageRow[]>();
  for (const row of due) {
    const rows = bySession.get(row.session_id) ?? [];
    rows.push(row);
    bySession.set(row.session_id, rows);
  }
  await Promise.all([...bySession.values()].map(async (rows) => {
    for (const row of rows) {
      await sendClaimedMessage(row, runtime);
    }
  }));

  return due.length;
}

/**
 * 다음에 깨어날 때까지의 시간. 가장 이른 예약, 다음 분의 시작, 안전망 간격 중
 * 가장 짧은 것이다.
 *
 * 분의 시작을 넣는 까닭: 확인과 확인 사이에 새로 걸린 "07:16" 예약은 아직 이
 * 계산에 없다. 시각으로 걸리는 예약은 언제나 분의 시작에 놓이므로 그때 한 번
 * 깨면 놓치지 않는다. "+10분" 같은 예약은 적어도 한 분 뒤라, 그 전의 확인이
 * 시각을 보고 정확히 맞춘다.
 */
export function nextWakeDelayMs(now: Date, nextDueAt: Date | null): number {
  const nowMs = now.getTime();
  const untilNextMinute = 60_000 - (nowMs % 60_000);
  let delay = Math.min(POLL_INTERVAL_MS, untilNextMinute);
  if (nextDueAt) {
    delay = Math.min(delay, nextDueAt.getTime() - nowMs);
  }
  return Math.max(0, delay) + WAKE_SLACK_MS;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (dispatcherRunning) {
    return;
  }
  dispatcherRunning = true;

  const armNextPoll = () => {
    if (!dispatcherRunning) {
      return;
    }
    let nextDueAt: Date | null = null;
    try {
      nextDueAt = scheduledMessagesDb.nextPendingAt();
    } catch (error) {
      console.error('[ScheduledMessages] 다음 예약 시각을 읽지 못했습니다', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 이미 지난 예약이 남아 있으면(앞선 확인이 아직 보내는 중이라 못 가져갔다)
    // 0 초로 계속 깨게 된다. 그럴 때는 1초에 한 번만 본다.
    const delay = nextWakeDelayMs(new Date(), nextDueAt);
    pollTimer = setTimeout(poll, delay <= WAKE_SLACK_MS ? IN_FLIGHT_RETRY_MS : delay);
    // Never keep the process alive just to poll for scheduled messages.
    pollTimer.unref?.();
  };

  const poll = () => {
    pollTimer = null;
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not. 건너뛰어도 다음
    // 확인은 다시 건다 — 타이머가 한 번짜리라 걸지 않으면 그대로 멈춘다.
    if (dispatchInFlight) {
      armNextPoll();
      return;
    }
    dispatchInFlight = true;
    const pass = dispatchDueScheduledMessages(runtime);
    // 때가 된 것을 가져간 뒤에야 다음 시각을 본다. 그 전에 보면 방금 보낸 예약에 다시 깬다.
    armNextPoll();
    void pass
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  // The poll is the safety net, not the mechanism. A queued turn goes out the
  // instant the run in front of it ends — waiting up to 30s for the next poll
  // is long enough that the user assumes their message was swallowed.
  unsubscribeRunSettled = chatRunRegistry.onRunSettled((sessionId) => {
    // 방금 끝난 답에 AI 가 남긴 예약 줄이 있으면 건다. 실패해도 대기열은 그대로 돈다.
    try {
      scheduleFromSettledRun(sessionId);
    } catch (error) {
      console.error('[ScheduledMessages] 답의 예약을 걸지 못했습니다', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    void dispatchQueuedMessages(runtime, sessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[QueuedMessages] Post-run dispatch failed', { sessionId, error: message });
    });
  });

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  dispatcherRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (unsubscribeRunSettled) {
    unsubscribeRunSettled();
    unsubscribeRunSettled = null;
  }
}
