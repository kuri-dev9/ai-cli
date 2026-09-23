import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { initializeRunStateBroadcast } from '@/modules/websocket/services/run-state-broadcast.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/** 프레임만 모아 두는 가짜 소켓. */
class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-state-broadcast-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
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

/**
 * 알림이 실제로 나갈 때까지 기다린다.
 *
 * 레지스트리는 리스너를 `setImmediate` 로 미뤄 부른다 — 리스너가 다음 턴을
 * 곧바로 시작해도 쓰기 도중에 재진입하지 않게 하려는 것이다. 그래서 동기로
 * 단언하면 아직 아무것도 나가지 않은 상태를 본다.
 */
async function flushDeferredNotifications(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
}

/** 이 프레임이 대상 세션의 run_state 인가. */
function runStateFrames(connection: FakeConnection, sessionId: string) {
  return connection.frames.filter(
    (frame) => frame.kind === 'run_state' && frame.sessionId === sessionId,
  );
}

test('소켓 없이 시작된 턴도 열려 있는 클라이언트에 "돌고 있음"으로 알려진다', async () => {
  await withIsolatedDatabase(async () => {
    const stop = initializeRunStateBroadcast();
    try {
      sessionsDb.createAppSession('app-detached-1', 'claude', '/workspace/demo');
      const watcher = new FakeConnection();
      connectedClients.add(watcher as never);

      // 텔레그램·예약 메시지가 지나는 길: 요청한 소켓이 없다.
      const run = chatRunRegistry.startRun({
        appSessionId: 'app-detached-1',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: 'user-1',
      });
      assert.ok(run);

      await flushDeferredNotifications();

      const started = runStateFrames(watcher, 'app-detached-1');
      assert.equal(started.length, 1);
      assert.equal(started[0].isProcessing, true);
    } finally {
      stop();
    }
  });
});

test('턴이 끝나면 실행 중 표시를 거두라고 알린다', async () => {
  await withIsolatedDatabase(async () => {
    const stop = initializeRunStateBroadcast();
    try {
      sessionsDb.createAppSession('app-detached-2', 'claude', '/workspace/demo');
      const watcher = new FakeConnection();
      connectedClients.add(watcher as never);

      chatRunRegistry.startRun({
        appSessionId: 'app-detached-2',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: 'user-1',
      });
      chatRunRegistry.completeRun('app-detached-2', { exitCode: 0 });

      await flushDeferredNotifications();

      const frames = runStateFrames(watcher, 'app-detached-2');
      assert.equal(frames.length, 2);
      assert.equal(frames[0].isProcessing, true);
      assert.equal(frames[1].isProcessing, false);
    } finally {
      stop();
    }
  });
});

test('닫힌 소켓에는 보내지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    const stop = initializeRunStateBroadcast();
    try {
      sessionsDb.createAppSession('app-detached-3', 'claude', '/workspace/demo');
      const closed = new FakeConnection();
      closed.readyState = 3; // CLOSED
      connectedClients.add(closed as never);

      chatRunRegistry.startRun({
        appSessionId: 'app-detached-3',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: 'user-1',
      });

      await flushDeferredNotifications();

      assert.equal(closed.frames.length, 0);
    } finally {
      stop();
    }
  });
});

test('그 턴을 이미 보고 있는 소켓에는 시작 알림을 보내지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    const stop = initializeRunStateBroadcast();
    try {
      sessionsDb.createAppSession('app-attached-1', 'claude', '/workspace/demo');
      const sender = new FakeConnection();
      connectedClients.add(sender as never);

      // 브라우저가 시킨 턴: 요청한 소켓이 곧 관객이다.
      chatRunRegistry.startRun({
        appSessionId: 'app-attached-1',
        provider: 'claude',
        providerSessionId: null,
        connection: sender as never,
        userId: 'user-1',
      });

      await flushDeferredNotifications();

      // 이 알림은 "붙어서 받아 가라"는 뜻이다. 이미 붙어 있는 쪽이 받으면 다시
      // 구독하면서 방금 받은 이벤트를 한 번 더 받게 된다.
      assert.equal(runStateFrames(sender, 'app-attached-1').length, 0);
    } finally {
      stop();
    }
  });
});

test('끝났다는 알림은 보고 있던 소켓에도 간다', async () => {
  await withIsolatedDatabase(async () => {
    const stop = initializeRunStateBroadcast();
    try {
      sessionsDb.createAppSession('app-attached-2', 'claude', '/workspace/demo');
      const sender = new FakeConnection();
      connectedClients.add(sender as never);

      chatRunRegistry.startRun({
        appSessionId: 'app-attached-2',
        provider: 'claude',
        providerSessionId: null,
        connection: sender as never,
        userId: 'user-1',
      });
      chatRunRegistry.completeRun('app-attached-2', { exitCode: 0 });

      await flushDeferredNotifications();

      // 표시등을 내리는 신호라서 붙어 있든 아니든 받아야 한다.
      const frames = runStateFrames(sender, 'app-attached-2');
      assert.equal(frames.length, 1);
      assert.equal(frames[0].isProcessing, false);
    } finally {
      stop();
    }
  });
});

test('두 번 초기화해도 알림이 겹쳐 붙지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    const stop = initializeRunStateBroadcast();
    initializeRunStateBroadcast();
    try {
      sessionsDb.createAppSession('app-detached-4', 'claude', '/workspace/demo');
      const watcher = new FakeConnection();
      connectedClients.add(watcher as never);

      chatRunRegistry.startRun({
        appSessionId: 'app-detached-4',
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId: 'user-1',
      });

      await flushDeferredNotifications();

      assert.equal(runStateFrames(watcher, 'app-detached-4').length, 1);
    } finally {
      stop();
    }
  });
});
