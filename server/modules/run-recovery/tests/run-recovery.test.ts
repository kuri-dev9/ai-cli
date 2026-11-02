import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeRunsDb, appConfigDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { MAX_RESUMES, RESUME_PROMPT, resumeInterruptedWork } from '@/modules/run-recovery/index.js';
import { activeRunJournal, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';

const SESSION_ID = 'chat-session';
const OTHER_SESSION = 'other-session';
const ROOM_SESSION = 'room-participant-session';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-recovery-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Chat');
    sessionsDb.createAppSession(OTHER_SESSION, 'claude', tempDirectory, 'Other');
    sessionsDb.createAppSession(ROOM_SESSION, 'claude', tempDirectory, 'Room member');
    await runTest();
  } finally {
    activeRunJournal.reset();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type RunCall = { sessionId: string; command: string; options: Record<string, unknown> };

/** `gate` 를 주면 그게 풀릴 때까지 실행이 끝나지 않는다. */
function createRuntime(calls: RunCall[], gate?: Promise<void>) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string, options: Record<string, unknown>) => {
      calls.push({ sessionId: String(options.sessionId), command, options });
      await gate;
    },
    abort: async () => true,
  } as never;
}

const dependencies = (runtime: never) => ({ runtime, isSessionHandedToTelegram: () => false });

function setHeartbeat(minutesAgo: number): void {
  appConfigDb.set('server_heartbeat_at', new Date(Date.now() - minutesAgo * 60_000).toISOString());
}

test('a running turn is in the journal, and leaves it when it ends', async () => {
  await withIsolatedDatabase(async () => {
    const calls: RunCall[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const done = runDetachedChatTurn({
      sessionId: SESSION_ID,
      userId: 7,
      content: '긴 작업',
      options: { model: 'opus', permissionMode: 'acceptEdits', attachments: [{ path: '/tmp/a.png' }] },
      origin: 'telegram',
    }, dependencies(createRuntime(calls, gate)));

    await waitFor(() => calls.length === 1, 'run started');
    const [row] = activeRunsDb.list();
    assert.equal(row.session_id, SESSION_ID);
    assert.equal(row.origin, 'telegram');
    assert.equal(row.owner, 'chat');
    assert.equal(row.user_id, '7');
    assert.equal(row.resume_count, 0);
    // 첨부는 이어 갈 때 다시 보내지 않는다. 이미 대화에 들어가 있다.
    assert.deepEqual(JSON.parse(row.options), { model: 'opus', permissionMode: 'acceptEdits' });

    release();
    await done;
    assert.deepEqual(activeRunsDb.list(), []);
  });
});

test('a turn that ends while the server is going down stays in the journal', async () => {
  await withIsolatedDatabase(async () => {
    const calls: RunCall[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content: '작업' }, dependencies(createRuntime(calls, gate)));
    await waitFor(() => calls.length === 1, 'run started');

    // 종료에 끌려 끝나는 실행이다. 지우면 다시 떠서 이어 갈 수 없다.
    activeRunJournal.markStopping();
    release();
    await done;
    assert.equal(activeRunsDb.list().length, 1);
  });
});

test('after a restart, an interrupted chat is told to continue with the options it ran with', async () => {
  await withIsolatedDatabase(async () => {
    activeRunsDb.start({ sessionId: SESSION_ID, runId: 'r1', provider: 'claude', origin: 'telegram', owner: 'chat', userId: 7, options: { model: 'opus' }, resumeCount: 0 });
    // 이미 끝까지 이어 간 일은 더 하지 않는다.
    activeRunsDb.start({ sessionId: OTHER_SESSION, runId: 'r2', provider: 'claude', origin: 'web', owner: 'chat', userId: 7, options: {}, resumeCount: MAX_RESUMES });
    // 룸 참가자의 차례는 룸이 이어 간다.
    activeRunsDb.start({ sessionId: ROOM_SESSION, runId: 'r3', provider: 'claude', origin: 'web', owner: 'room', userId: 7, options: {}, resumeCount: 0 });
    setHeartbeat(5);

    const calls: RunCall[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const report = resumeInterruptedWork(createRuntime(calls, gate));

    assert.deepEqual(report.resumedSessions, [SESSION_ID]);
    assert.deepEqual(report.skippedSessions.map((entry) => entry.sessionId), [OTHER_SESSION]);
    await waitFor(() => calls.length === 1, 'resumed run started');
    assert.equal(calls[0].sessionId, SESSION_ID);
    assert.equal(calls[0].command, RESUME_PROMPT);
    assert.equal(calls[0].options.model, 'opus');

    // 이어 가는 실행도 일지에 적힌다. 또 끊기면 몇 번째인지 안다.
    const rows = activeRunsDb.list();
    assert.deepEqual(rows.map((row) => [row.session_id, row.resume_count, row.origin]), [[SESSION_ID, 1, 'telegram']]);

    release();
    await waitFor(() => activeRunsDb.list().length === 0, 'resumed run ended');
  });
});

test('nothing is resumed when the server was down for more than an hour', async () => {
  await withIsolatedDatabase(async () => {
    activeRunsDb.start({ sessionId: SESSION_ID, runId: 'r1', provider: 'claude', origin: 'web', owner: 'chat', userId: 1, options: {}, resumeCount: 0 });
    setHeartbeat(90);

    const calls: RunCall[] = [];
    const report = resumeInterruptedWork(createRuntime(calls));

    assert.equal(report.stale, true);
    assert.deepEqual(report.resumedSessions, []);
    assert.equal(calls.length, 0);
    assert.deepEqual(activeRunsDb.list(), []);
    // 박동은 새로 시작했다. 다음에 내려가면 그때부터 잰다.
    const heartbeat = activeRunJournal.readLastHeartbeat();
    assert.ok(heartbeat && Date.now() - heartbeat.getTime() < 5_000);
  });
});
