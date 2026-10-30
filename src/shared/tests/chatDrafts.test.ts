import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Drafts moved out of the browser and into auth.db so a message half-typed on
 * one device can be finished on another — the case the composer could not serve
 * at all before, because a draft only existed on the machine it was typed on.
 *
 * Each test loads a fresh module copy, because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedDraft = { scope: string; text: string; queuedMessage?: unknown };

const savedDrafts: SavedDraft[] = [];
const deletedScopes: string[] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: async () => {
        if (draftsRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, drafts: serverDrafts }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      saveDraft: async (scope: string, draft: { text: string; queuedMessage?: unknown }) => {
        savedDrafts.push({ scope, ...draft });
        return new Response('{}', { status: 200 });
      },
      deleteDraft: async (scope: string) => {
        deletedScopes.push(scope);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/chatDrafts');
};

beforeEach(() => {
  localStorage.clear();
  savedDrafts.length = 0;
  deletedScopes.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a draft is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'half a thought');

  assert.equal(store.readDraftText('session-a'), 'half a thought');
  assert.deepEqual(savedDrafts, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [
    { scope: 'session-a', text: 'half a thought', queuedMessage: null },
  ]);
});

test('each session keeps its own draft', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'for A');
  store.writeDraftText('session-b', 'for B');

  assert.equal(store.readDraftText('session-a'), 'for A');
  assert.equal(store.readDraftText('session-b'), 'for B');
});

test('a chat with no session yet is scoped to its project', async () => {
  const store = await loadStore();

  store.writeDraftText('project:p1', 'unsent');

  assert.equal(store.readDraftText('project:p1'), 'unsent');
  assert.equal(store.readDraftText('session-a'), '');
});

test('clearing a draft deletes it on the server instead of storing an empty one', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  assert.deepEqual(savedDrafts, []);
  assert.deepEqual(deletedScopes, ['session-a']);
});

test('a draft written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeDraftText('session-a', 'survives a reload');

  // No hydrate: this is the first paint of the next load, before any request
  // could have resolved.
  const second = await loadStore();
  assert.equal(second.readDraftText('session-a'), 'survives a reload');
});

test('hydrate brings in a draft typed on another device', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'typed on the laptop', queuedMessage: null }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'typed on the laptop');
});

test('hydrate removes a mirrored queue after the server claims it', async () => {
  const store = await loadStore();
  store.appendQueuedMessage('session-a', { content: 'server-owned queue' });
  assert.equal(store.readQueuedMessages('session-a')[0]?.content, 'server-owned queue');
  // 서버가 이 저장을 받았다고 답한 뒤라야 그 뒤의 빈 목록을 "가져갔다" 로 읽는다.
  await vi.advanceTimersByTimeAsync(0);

  serverDrafts = [];
  await store.hydrateChatDrafts();

  assert.deepEqual(store.readQueuedMessages('session-a'), []);
});

test('hydrate does not overwrite a scope the user is typing into right now', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
});

test('a failed hydrate keeps the mirrored draft rather than blanking the composer', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'local work');
  await vi.advanceTimersByTimeAsync(1_500);

  draftsRequestFailed = true;
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'local work');
});

test('a queued message round-trips alongside the draft text', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'still editing');
  store.appendQueuedMessage('session-a', { content: 'send this next', attachments: [] });

  assert.equal(store.readDraftText('session-a'), 'still editing');
  assert.deepEqual(store.readQueuedMessages('session-a'), [{
    content: 'send this next',
    attachments: [],
  }]);
  assert.equal(savedDrafts.length, 1, 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(savedDrafts, [{
    scope: 'session-a',
    text: 'still editing',
    queuedMessage: { v: 2, items: [{ content: 'send this next', attachments: [] }] },
  }]);
});

test('queueing a second message keeps the first one', async () => {
  const store = await loadStore();

  store.appendQueuedMessage('session-a', { content: 'first' });
  store.appendQueuedMessage('session-a', { content: 'second' });

  assert.deepEqual(
    store.readQueuedMessages('session-a').map((message) => message.content),
    ['first', 'second'],
  );
});

test('a queue written by the old single-message build still reads back', async () => {
  serverDrafts = [{
    scope: 'session-a',
    text: '',
    queuedMessage: { content: 'queued before the upgrade', attachments: [] },
  }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.deepEqual(
    store.readQueuedMessages('session-a').map((message) => message.content),
    ['queued before the upgrade'],
  );
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  const store = await loadStore();

  store.appendQueuedMessage('session-a', { content: '   ', attachments: [] });

  assert.deepEqual(store.readQueuedMessages('session-a'), []);
});

test('legacy image-only descriptors are still readable as attachments', async () => {
  const store = await loadStore();

  store.appendQueuedMessage('session-a', { content: '', images: [{ name: 'shot.png' }] });

  assert.deepEqual(store.readQueuedMessages('session-a')[0]?.attachments, [{ name: 'shot.png' }]);
});

test('clearing the queue leaves the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  store.appendQueuedMessage('session-a', { content: 'queued' });

  store.clearQueuedMessages('session-a');

  assert.deepEqual(store.readQueuedMessages('session-a'), []);
  assert.equal(store.readDraftText('session-a'), 'keep me');
});

test('subscribers are notified on a write', async () => {
  const store = await loadStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribeToChatDrafts(listener);

  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  // Writing the same text again changes nothing, so nobody is woken.
  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  unsubscribe();
  store.writeDraftText('session-a', 'more');
  assert.equal(listener.mock.calls.length, 1);
});

test('reset clears the drafts so the next user does not see them', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'private');

  store.resetChatDrafts();

  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});

/*
 * 세션마다 따로 간다. 한 세션의 대기 목록 때문에 hydrate 가 5초마다 돌아도,
 * 다른 세션 입력창의 글은 되돌아가지도 지워지지도 않고, 깨어나지도 않는다.
 */

test('hydrate does not revert a draft whose save left but has not been answered', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];
  let answerSave: (response: Response) => void = () => undefined;
  const api = (await import('@/shared/api')).api;
  const saveDraft = vi.spyOn(api.user, 'saveDraft').mockImplementation(
    () => new Promise<Response>((resolve) => { answerSave = resolve; }),
  );

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.equal(saveDraft.mock.calls.length, 1);

  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'what I am writing');

  // 서버가 받았다고 답한 뒤에는 서버 사본이 다시 기준이 된다.
  answerSave(new Response('{}', { status: 200 }));
  await vi.advanceTimersByTimeAsync(0);
  serverDrafts = [{ scope: 'session-a', text: 'what I am writing', queuedMessage: null }];
  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-a'), 'what I am writing');
  saveDraft.mockRestore();
});

/** 저장 요청의 답을 붙잡아 둔다. 서버가 아직 커밋하지 않은 순간을 만든다. */
const holdSaves = async () => {
  const api = (await import('@/shared/api')).api;
  const answers: Array<() => void> = [];
  const spy = vi.spyOn(api.user, 'saveDraft').mockImplementation(
    () => new Promise<Response>((resolve) => {
      answers.push(() => resolve(new Response('{}', { status: 200 })));
    }),
  );
  return { answerAll: () => answers.splice(0).forEach((answer) => answer()), restore: () => spy.mockRestore() };
};

test('a snapshot requested before the save answered is not adopted, even if the answer lands first', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessage: null }];
  const saves = await holdSaves();

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await vi.advanceTimersByTimeAsync(1_000);

  // GET 이 먼저 떠나고, 그 뒤에 POST 의 답이 도착한다. GET 은 옛 글을 들고 온다.
  const hydrating = store.hydrateChatDrafts();
  saves.answerAll();
  await hydrating;

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
  saves.restore();
});

test('a draft the server has not stored yet survives a hydrate', async () => {
  serverDrafts = [];
  const saves = await holdSaves();

  const store = await loadStore();
  store.writeDraftText('session-b', 'typed here only');
  await vi.advanceTimersByTimeAsync(1_000);

  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-b'), 'typed here only');
  saves.restore();
});

test('a draft whose save failed stays local until it is sent again', async () => {
  const api = (await import('@/shared/api')).api;
  const saveDraft = vi.spyOn(api.user, 'saveDraft')
    .mockResolvedValueOnce(new Response('{}', { status: 500 }));

  const store = await loadStore();
  store.writeDraftText('session-b', 'not on the server');
  await vi.advanceTimersByTimeAsync(1_500);

  serverDrafts = [];
  await store.hydrateChatDrafts();
  assert.equal(store.readDraftText('session-b'), 'not on the server');

  // 다음 flush 가 다시 보낸다.
  store.writeDraftText('session-c', 'any other write');
  await vi.advanceTimersByTimeAsync(1_500);
  assert.ok(saveDraft.mock.calls.some(([scope]) => scope === 'session-b'));
  saveDraft.mockRestore();
});

test('hydrate tells only the scopes it changed, and stays silent when nothing did', async () => {
  const store = await loadStore();
  store.writeDraftText('session-mine', 'mine');
  await vi.advanceTimersByTimeAsync(1_500);

  const seen: Array<string | null> = [];
  store.subscribeToChatDrafts((scope) => { seen.push(scope); });

  serverDrafts = [
    { scope: 'session-mine', text: 'mine', queuedMessage: null },
    { scope: 'session-other', text: 'someone else', queuedMessage: null },
  ];
  await store.hydrateChatDrafts();
  assert.deepEqual(seen, ['session-other']);

  seen.length = 0;
  await store.hydrateChatDrafts();
  assert.deepEqual(seen, []);
});

test('another session claiming its queue leaves this session untouched', async () => {
  const store = await loadStore();
  store.writeDraftText('session-mine', 'half written');
  store.appendQueuedMessage('session-busy', { content: 'waiting for its turn' });
  await vi.advanceTimersByTimeAsync(1_500);

  const seen: Array<string | null> = [];
  store.subscribeToChatDrafts((scope) => { seen.push(scope); });

  // 디스패처가 바쁜 세션의 대기 메시지를 가져갔다.
  serverDrafts = [{ scope: 'session-mine', text: 'half written', queuedMessage: null }];
  await store.hydrateChatDrafts();

  assert.deepEqual(seen, ['session-busy']);
  assert.deepEqual(store.readQueuedMessages('session-busy'), []);
  assert.equal(store.readDraftText('session-mine'), 'half written');
});
