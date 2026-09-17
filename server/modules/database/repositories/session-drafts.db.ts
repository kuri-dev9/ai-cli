import { getConnection } from '@/modules/database/connection.js';

/**
 * One chat scope's unsent state: the text still in the composer, plus the
 * messages queued behind an in-flight turn. Both are optional — a scope can
 * hold only a draft, only a queue, or both.
 *
 * The queue column holds a list, not a single message. It used to hold one
 * object, which meant a second message typed while a turn was running silently
 * replaced the first: the user sent three follow-ups and only the last one ever
 * ran. The list is stored under a version wrapper so a queue written by the old
 * build still reads back as a one-item queue instead of being dropped.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessage: unknown | null;
  updatedAt: string;
};

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
};

/**
 * The next queued turn to run, plus the tokens needed to take it exactly once.
 *
 * `claimToken` is the column's current raw value and `remainderToken` is what
 * the column must hold after this turn is taken — comparing the former in the
 * UPDATE's WHERE clause is what stops two dispatch passes from claiming the
 * same message.
 */
export type QueuedSessionMessageRecord = {
  userId: number;
  sessionId: string;
  queuedMessage: unknown;
  claimToken: string;
  remainderToken: string | null;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

/** Stored shape of a queue: a version wrapper around the pending turns. */
type QueuedMessageEnvelope = {
  v: 2;
  items: unknown[];
};

const QUEUE_ENVELOPE_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a queue column into a list of turns.
 *
 * Three shapes reach this: the current envelope, a bare array, and the single
 * object written by builds before the queue held more than one message.
 */
export function readQueuedMessageList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items.filter(Boolean);
  }
  return value ? [value] : [];
}

/** Serializes a queue, or null when nothing is left to keep. */
export function serializeQueuedMessageList(items: unknown[]): string | null {
  const pending = items.filter(Boolean);
  if (pending.length === 0) {
    return null;
  }
  const envelope: QueuedMessageEnvelope = { v: QUEUE_ENVELOPE_VERSION, items: pending };
  return JSON.stringify(envelope);
}

/** A queued message that no longer parses is treated as absent, not fatal. */
function parseQueuedMessage(raw: string | null): unknown | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessage: parseQueuedMessage(row.queued_message),
    updatedAt: row.updated_at,
  };
}

export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /**
   * Next queued turn for every session that has one.
   *
   * One candidate per session, never the whole queue: a session runs one turn
   * at a time, so the rest stay in the column until this one has finished.
   */
  listQueuedMessages(sessionId?: string): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL
           AND (? IS NULL OR drafts.draft_scope = ?)`
      )
      .all(sessionId ?? null, sessionId ?? null) as QueuedMessageRow[];

    const candidates: QueuedSessionMessageRecord[] = [];
    for (const row of rows) {
      const items = readQueuedMessageList(parseQueuedMessage(row.queued_message));
      if (items.length === 0) {
        continue;
      }

      candidates.push({
        userId: row.user_id,
        sessionId: row.draft_scope,
        queuedMessage: items[0],
        claimToken: row.queued_message,
        remainderToken: serializeQueuedMessageList(items.slice(1)),
      });
    }
    return candidates;
  },

  /**
   * Takes the next turn off a session's queue, leaving the rest in place.
   *
   * The `queued_message = claimToken` guard makes this a compare-and-set: if
   * the user added or removed a message since it was listed, the column no
   * longer matches, nothing is taken, and the next pass re-reads the queue.
   */
  claimQueuedMessage(candidate: QueuedSessionMessageRecord): boolean {
    const result = getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      )
      .run(
        candidate.remainderToken,
        candidate.userId,
        candidate.sessionId,
        candidate.claimToken,
      );
    return result.changes > 0;
  },

  /**
   * Puts a claimed turn back at the head of the queue.
   *
   * Reads the column inside the write because the user may have queued more
   * messages while this one was in flight — those must stay, and this one has
   * to go back in front of them to keep the order the user typed.
   */
  restoreQueuedMessage(candidate: QueuedSessionMessageRecord): void {
    const db = getConnection();
    const restore = db.transaction(() => {
      const row = db
        .prepare(
          `SELECT queued_message FROM session_drafts
           WHERE user_id = ? AND draft_scope = ?`
        )
        .get(candidate.userId, candidate.sessionId) as { queued_message: string | null } | undefined;

      const pending = readQueuedMessageList(parseQueuedMessage(row?.queued_message ?? null));
      const restored = serializeQueuedMessageList([candidate.queuedMessage, ...pending]);

      if (row) {
        db.prepare(
          `UPDATE session_drafts
           SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND draft_scope = ?`
        ).run(restored, candidate.userId, candidate.sessionId);
        return;
      }

      // The row is deleted once a queue empties out, so a turn that has to go
      // back may have no row left to go back into.
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           queued_message = excluded.queued_message,
           updated_at = CURRENT_TIMESTAMP`
      ).run(candidate.userId, candidate.sessionId, restored);
    });

    restore();
  },

  /**
   * Adds one turn to the end of a scope's queue.
   *
   * The composer does this from the browser; the Telegram bridge does it for a
   * message that arrives while a turn is already running, so an outside command
   * queues up exactly like one typed into the app instead of being refused.
   */
  appendQueuedMessage(userId: number, scope: string, message: unknown): void {
    const db = getConnection();
    const append = db.transaction(() => {
      const row = db
        .prepare(
          `SELECT draft_text, queued_message FROM session_drafts
           WHERE user_id = ? AND draft_scope = ?`
        )
        .get(userId, scope) as { draft_text: string; queued_message: string | null } | undefined;

      const pending = readQueuedMessageList(parseQueuedMessage(row?.queued_message ?? null));
      const queued = serializeQueuedMessageList([...pending, message]);

      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           queued_message = excluded.queued_message,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, scope, row?.draft_text ?? '', queued);
    });

    append();
  },

  /** Number of turns waiting on a scope's queue. */
  countQueuedMessages(userId: number, scope: string): number {
    const row = getConnection()
      .prepare(
        `SELECT queued_message FROM session_drafts
         WHERE user_id = ? AND draft_scope = ?`
      )
      .get(userId, scope) as { queued_message: string | null } | undefined;

    return readQueuedMessageList(parseQueuedMessage(row?.queued_message ?? null)).length;
  },

  /** Removes the placeholder row left after its last queued turn is claimed. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's draft, or deletes the row when nothing is left to keep.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessage: unknown | null }
  ): void {
    const db = getConnection();

    if (!draft.text && draft.queuedMessage === null) {
      db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .run(userId, scope);
      return;
    }

    db.prepare(
      `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, draft_scope) DO UPDATE SET
         draft_text = excluded.draft_text,
         queued_message = excluded.queued_message,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      scope,
      draft.text,
      draft.queuedMessage === null ? null : JSON.stringify(draft.queuedMessage)
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
