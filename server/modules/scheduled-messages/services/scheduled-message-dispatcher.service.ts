import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ChatRunOrigin, ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
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
      { runtime },
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

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
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
      { runtime },
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

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // The poll is the safety net, not the mechanism. A queued turn goes out the
  // instant the run in front of it ends — waiting up to 30s for the next poll
  // is long enough that the user assumes their message was swallowed.
  unsubscribeRunSettled = chatRunRegistry.onRunSettled((sessionId) => {
    void dispatchQueuedMessages(runtime, sessionId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[QueuedMessages] Post-run dispatch failed', { sessionId, error: message });
    });
  });

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (unsubscribeRunSettled) {
    unsubscribeRunSettled();
    unsubscribeRunSettled = null;
  }
}
