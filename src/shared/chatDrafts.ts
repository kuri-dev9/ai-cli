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

/** 바뀐 스코프를 받는다. `null` 은 전부 갈렸다는 뜻이다. */
export type ChatDraftListener = (changedScope: string | null) => void;

const listeners = new Set<ChatDraftListener>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
/**
 * 서버로 떠났지만 아직 답을 받지 못한 저장. 스코프마다 가장 최근 요청만 둔다.
 *
 * 디바운스가 터지는 순간 `pendingScopes` 에서는 빠지지만, 서버가 그 글을
 * 실제로 받기 전까지는 서버 사본이 여전히 옛 글이다. 그 사이에 hydrate 가
 * 끼어들면 옛 글을 정답으로 받아들여 입력창을 되돌렸다.
 */
const inFlightWrites = new Map<string, Promise<unknown>>();
/** 이 탭에서 고친 순번. hydrate 가 자기가 출발한 뒤에 난 수정을 알아보는 데 쓴다. */
let localWriteSeq = 0;
const lastLocalWrite = new Map<string, number>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessages.length === 0
);

const isSameDraft = (a: DraftRecord, b: DraftRecord): boolean => (
  a.text === b.text && JSON.stringify(a.queuedMessages) === JSON.stringify(b.queuedMessages)
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

/**
 * 바뀐 스코프를 하나씩 알린다. `null` 은 "전부 갈렸다" 는 뜻이고 로그아웃
 * 때만 쓴다.
 *
 * 예전에는 무엇이 바뀌었는지 말하지 않고 모두를 깨웠다. 룸이 한 차례 돌 때마다
 * 참가자 대기 목록이 갱신되므로, 룸과 아무 상관없는 대화의 입력창까지 같이
 * 깨어나 제 글을 저장본으로 덮어썼다. hydrate 도 한동안 `null` 로 알렸는데,
 * 한 세션에 대기 메시지가 있는 동안 5초마다 hydrate 가 돌아서 같은 일이
 * 되풀이됐다. 받는 쪽에서 거르기에는 이미 늦은 일이라 보내는 쪽에서 밝힌다.
 */
function notifyListeners(changedScopes: readonly string[] | null): void {
  for (const listener of listeners) {
    if (changedScopes === null) {
      listener(null);
      continue;
    }
    for (const scope of changedScopes) {
      listener(scope);
    }
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
      const request = !draft || isEmptyDraft(draft)
        ? api.user.deleteDraft(scope)
        : api.user.saveDraft(scope, {
          text: draft.text,
          queuedMessage: toQueuePayload(draft.queuedMessages),
        });
      trackServerWrite(scope, request);
    } catch (error) {
      console.error('Failed to save chat draft:', error);
      pendingScopes.add(scope);
    }
  }
}

/**
 * 서버가 답할 때까지 그 스코프를 이 탭의 것으로 둔다. 실패하면 다시
 * `pendingScopes` 로 돌려놓는다 — 서버에는 이 글이 없으니 hydrate 가 지우면
 * 안 되고, 다음 flush 가 다시 보낸다.
 */
function trackServerWrite(scope: string, request: Promise<Response>): void {
  const tracked: Promise<unknown> = request
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    })
    .catch((error: unknown) => {
      console.error('Failed to save chat draft:', error);
      pendingScopes.add(scope);
    })
    .finally(() => {
      if (inFlightWrites.get(scope) === tracked) {
        inFlightWrites.delete(scope);
      }
    });
  inFlightWrites.set(scope, tracked);
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
  localWriteSeq += 1;
  lastLocalWrite.set(scope, localWriteSeq);

  writeMirror();
  queueServerWrite(scope);
  notifyListeners([scope]);
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

/**
 * 임시 저장이 바뀌면 알려 준다. 돌려주는 함수를 부르면 구독이 끊긴다.
 *
 * 콜백은 바뀐 스코프를 받는다. `null` 이면 전부 갈린 것이다. 자기와 상관없는
 * 스코프까지 반응하면 남의 대화에서 난 일로 제 입력창을 되돌리게 된다.
 */
export function subscribeToChatDrafts(listener: ChatDraftListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 서버의 임시 저장을 들여온다. 다른 기기에서 쓴 글과, 디스패처가 가져가서
 * 사라진 대기 목록이 이 경로로 들어온다.
 *
 * 이 탭이 고쳤는데 서버가 아직 받았다고 답하지 않은 스코프는 건드리지 않는다.
 * 서버 사본이 그보다 낡았으니, 받아들이면 지금 쓰고 있는 글이 되돌아간다.
 */
export async function hydrateChatDrafts(): Promise<void> {
  // 출발 시점에 아직 서버에 닿지 않은 글은 이 응답에 반영됐을 리 없다.
  const startedAtSeq = localWriteSeq;
  const unsettledAtStart = new Set([...pendingScopes, ...inFlightWrites.keys()]);

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

  const remote = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (scope) {
      remote.set(scope, {
        text: typeof draft.text === 'string' ? draft.text : '',
        queuedMessages: readQueueValue(draft.queuedMessage),
      });
    }
  }

  // 이 탭이 고쳤는데 서버가 아직 받았다고 답하지 않은 스코프는 이 탭의 것이다.
  const isOwnedLocally = (scope: string): boolean => (
    pendingScopes.has(scope)
    || inFlightWrites.has(scope)
    || unsettledAtStart.has(scope)
    || (lastLocalWrite.get(scope) ?? 0) > startedAtSeq
  );

  // 스코프마다 따로 판단한다. 서버와 같은 스코프는 원래 객체를 그대로 두고,
  // 달라진 스코프만 갈아끼워 그 스코프에만 알린다. 다른 세션의 hydrate 가
  // 이 세션 입력창을 깨우는 일이 없어야 한다.
  const next = new Map<string, DraftRecord>();
  const changed: string[] = [];
  for (const scope of new Set([...drafts.keys(), ...remote.keys()])) {
    const local = drafts.get(scope);
    if (isOwnedLocally(scope)) {
      if (local) {
        next.set(scope, local);
      }
      continue;
    }

    const incoming = remote.get(scope);
    if (local && incoming && isSameDraft(local, incoming)) {
      next.set(scope, local);
      continue;
    }
    // 서버에 없는 스코프는 다른 곳에서 지워졌거나 디스패처가 가져간 것이다.
    if (incoming && !isEmptyDraft(incoming)) {
      next.set(scope, incoming);
    }
    if (local || (incoming && !isEmptyDraft(incoming))) {
      changed.push(scope);
    }
  }

  if (changed.length === 0) {
    return;
  }

  drafts = next;
  writeMirror();
  notifyListeners(changed);
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  drafts = new Map();
  pendingScopes.clear();
  inFlightWrites.clear();
  lastLocalWrite.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners(null);
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
