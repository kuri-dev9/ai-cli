import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * 세션의 자동 대화 줄이기. 기준에 걸리면 보낸 글보다 먼저 `/compact` 가 한 턴
 * 돌고, 줄인 뒤로 턴 수를 다시 센다.
 */

const SESSION_ID = 'chat-auto-compact-session';

async function withSession(runTest: (context: { commands: string[]; dependencies: never }) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-auto-compact-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const commands: string[] = [];
  const runtime = {
    hasRuntime: () => true,
    run: async (_provider: string, command: string) => {
      commands.push(command);
    },
    getPendingApprovalsForSession: () => [],
  };

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Auto compact', now, now, null);
    await runTest({ commands, dependencies: { runtime, isSessionHandedToTelegram: () => false } as never });
  } finally {
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

const send = (content: string, dependencies: never, extra: Record<string, unknown> = {}) =>
  runDetachedChatTurn({ sessionId: SESSION_ID, userId: 1, content, ...extra }, dependencies);

test('N턴마다로 정하면 그만큼 쌓인 뒤의 글 앞에 /compact 가 먼저 돈다', async () => {
  await withSession(async ({ commands, dependencies }) => {
    sessionsDb.setAutoCompactSettings(SESSION_ID, { everyTurns: 2 });

    await send('하나', dependencies);
    await send('둘', dependencies);
    await send('셋', dependencies);

    assert.deepEqual(commands, ['하나', '둘', '/compact', '셋']);
    // 줄인 뒤로는 '셋' 한 턴만 셌다.
    assert.equal(sessionsDb.getAutoCompactState(SESSION_ID)?.turnsSinceCompact, 1);
  });
});

test('기준을 정하지 않은 세션은 몇 턴이 쌓여도 스스로 줄이지 않는다', async () => {
  await withSession(async ({ commands, dependencies }) => {
    for (const content of ['하나', '둘', '셋']) {
      await send(content, dependencies);
    }
    assert.deepEqual(commands, ['하나', '둘', '셋']);
    assert.equal(sessionsDb.getAutoCompactState(SESSION_ID)?.turnsSinceCompact, 3);
  });
});

test('사용자가 직접 /compact 를 보내면 셈이 처음부터 다시 시작되고, 슬래시 명령 앞에서는 줄이지 않는다', async () => {
  await withSession(async ({ commands, dependencies }) => {
    sessionsDb.setAutoCompactSettings(SESSION_ID, { everyTurns: 1 });

    await send('하나', dependencies);
    await send('/compact', dependencies);
    assert.equal(sessionsDb.getAutoCompactState(SESSION_ID)?.turnsSinceCompact, 0);

    await send('둘', dependencies);
    await send('/model', dependencies);

    assert.deepEqual(commands, ['하나', '/compact', '둘', '/model']);
  });
});

test('룸 차례와 끊긴 실행을 이어 가는 턴은 세션 기준으로 줄이지 않는다', async () => {
  await withSession(async ({ commands, dependencies }) => {
    sessionsDb.setAutoCompactSettings(SESSION_ID, { everyTurns: 1 });

    await send('하나', dependencies);
    await send('룸 차례', dependencies, { owner: 'room' });
    await send('이어 가기', dependencies, { resumeCount: 1 });

    assert.deepEqual(commands, ['하나', '룸 차례', '이어 가기']);
  });
});

test('줄인 뒤 아직 한 턴도 돌지 않았으면 기준에 닿아 있어도 연달아 또 줄이지 않는다', async () => {
  await withSession(async ({ commands, dependencies }) => {
    sessionsDb.setAutoCompactSettings(SESSION_ID, { everyTurns: 1 });

    await send('하나', dependencies);
    await send('/compact', dependencies);
    assert.equal(sessionsDb.getAutoCompactState(SESSION_ID)?.awaitingTurnAfterCompact, true);

    await send('둘', dependencies);
    assert.deepEqual(commands, ['하나', '/compact', '둘']);
    assert.equal(sessionsDb.getAutoCompactState(SESSION_ID)?.awaitingTurnAfterCompact, false);
  });
});
