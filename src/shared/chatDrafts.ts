import { api } from '@/shared/api';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  /**
   * 실행 중인 턴 뒤에 줄 서 있는 메시지들. 보낸 순서대로다.
   *
   * 예전에는 한 건만 담을 수 있어서, 턴이 도는 동안 두 번째 질문을 보내면
   * 첫 번째를 조용히 덮어썼다. 나중에 "아까 물어본 거"를 찾으면 흔적도 없던
   * 이유가 이것이다.
   */
  queuedMessages: StoredQueuedMessage[];
};

/** 저장 포맷: 버전 봉투에 담긴 대기 목록. 서버 DB도 같은 모양으로 읽는다. */
type StoredQueueEnvelope = {
  v: 2;
  items: StoredQueuedMessage[];
};

const QUEUE_ENVELOPE_VERSION = 2;

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessages: [] };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessages.length === 0
);

/** 저장된 값이 어떤 세대의 포맷이든 대기 목록으로 읽는다. */
function readQueueValue(value: unknown): StoredQueuedMessage[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : value
        ? [value]
        : [];

  return items.filter(isRecord) as StoredQueuedMessage[];
}

/** 서버로 보낼 형태. 비어 있으면 null — 서버는 그때 행을 지운다. */
function toQueuePayload(items: StoredQueuedMessage[]): StoredQueueEnvelope | null {
  return items.length > 0 ? { v: QUEUE_ENVELOPE_VERSION, items } : null;
}

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessages: readQueueValue(value.queuedMessages ?? value.queuedMessage),
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes];
  pendingScopes.clear();

  for (const scope of scopes) {
    const draft = drafts.get(scope);

    // A save that fails must never surface as an unhandled rejection out of a
    // timer callback: the mirror already holds the draft, and the next
    // keystroke re-sends it.
    try {
      if (!draft || isEmptyDraft(draft)) {
        void api.user.deleteDraft(scope).catch((error: unknown) => {
          console.error('Failed to delete chat draft:', error);
        });
        continue;
      }

      void api.user.saveDraft(scope, {
        text: draft.text,
        queuedMessage: toQueuePayload(draft.queuedMessages),
      }).catch((error: unknown) => {
        console.error('Failed to save chat draft:', error);
      });
    } catch (error) {
      console.error('Failed to save chat draft:', error);
    }
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

function flushServerWritesNow(): void {
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  flushServerWrites();
}

function updateDraft(scope: string, update: Partial<DraftRecord>): void {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && next.queuedMessages === current.queuedMessages) {
    return;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;

  writeMirror();
  queueServerWrite(scope);
  notifyListeners();
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  updateDraft(scope, { text });
}

/** 보낼 내용이 있는 항목만 남기고, 첨부 필드를 한 가지 모양으로 맞춘다. */
function normalizeQueuedMessage(queued: StoredQueuedMessage): StoredQueuedMessage | null {
  const attachments = Array.isArray(queued.attachments)
    ? queued.attachments
    : Array.isArray(queued.images)
      ? queued.images
      : [];

  // A queued message with neither text nor attachments has nothing to send.
  return queued.content.trim() || attachments.length > 0
    ? { ...queued, attachments }
    : null;
}

/** 한 세션의 대기 목록. 보낸 순서 그대로다. */
export function readQueuedMessages(scope: string): StoredQueuedMessage[] {
  const queued = drafts.get(scope)?.queuedMessages ?? [];
  return queued
    .map(normalizeQueuedMessage)
    .filter((message): message is StoredQueuedMessage => message !== null);
}

/** 대기 목록 맨 뒤에 한 건 추가한다. 기존 항목은 그대로 둔다. */
export function appendQueuedMessage(scope: string, message: StoredQueuedMessage): void {
  const current = drafts.get(scope)?.queuedMessages ?? [];
  updateDraft(scope, { queuedMessages: [...current, message] });
  // Queueing is a send-like action, so persist it before the tab can close.
  flushServerWritesNow();
}

/** 대기 목록 전체를 갈아끼운다. 순서 변경·수정·부분 삭제가 모두 여기로 온다. */
export function writeQueuedMessages(scope: string, messages: StoredQueuedMessage[]): void {
  updateDraft(scope, { queuedMessages: messages });
  // Editing or cancelling must beat the server's next dispatcher poll.
  flushServerWritesNow();
}

export function clearQueuedMessages(scope: string): void {
  writeQueuedMessages(scope, []);
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessage?: unknown }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope || pendingScopes.has(scope)) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessages: readQueueValue(draft.queuedMessage),
    });
  }

  // Local edits whose debounced write has not left the browser yet win over
  // the server snapshot. Every other missing scope was deleted remotely and
  // must also disappear from the mirror.
  for (const scope of pendingScopes) {
    const pending = drafts.get(scope);
    if (pending) {
      merged.set(scope, pending);
    }
  }

  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  drafts = new Map();
  pendingScopes.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
