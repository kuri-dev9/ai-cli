import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import {
  handleChatConnection,
  runDetachedChatTurn,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * 브라우저가 시키지 않은 턴이 열려 있는 화면에 보이는가.
 *
 * 텔레그램으로 한 줄 보내 놓고 웹 화면을 보고 있으면, 예전에는 보낸 글이
 * 보이지 않고 표시등만 돌았다. 그 턴의 이벤트는 요청한 소켓으로만 나가는데
 * 요청한 소켓이 없었기 때문이다. 승인 요청도 같은 이유로 아무에게도 닿지
 * 못한 채 55초 뒤 거부로 끝났다.
 */

const SESSION_ID = 'detached-visibility-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (data: string) => void;
    frames: Array<Record<string, unknown>>;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => {
    socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  };
  return socket;
}

async function withGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runtime: unknown;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'detached-run-visibility-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const socket = createFakeSocket();
  const runtime = {
    hasRuntime: () => true,
    run: async () => {},
    getPendingApprovalsForSession: () => [],
  };

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Detached session', now, now, null);

    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime } as never);
    await runTest({ socket, runtime });
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

/** 소켓 리스너는 async 핸들러를 기다리지 않는다. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

function userEchoes(sessionId: string): NormalizedMessage[] {
  return chatRunRegistry
    .replayEvents(sessionId, 0)
    .filter((event) => event.kind === 'text' && event.role === 'user');
}

test('텔레그램에서 보낸 글이 실행 스트림에 바로 남는다', async () => {
  await withGateway(async ({ runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '이어서 해줘', origin: 'telegram' },
      { runtime } as never,
    );

    const echoes = userEchoes(SESSION_ID);
    assert.equal(echoes.length, 1);
    assert.equal(echoes[0].content, '이어서 해줘');
    // 밖에서 들어온 글이라는 표시. 기록이 따라잡기 전에도 배지가 보여야 한다.
    assert.equal(echoes[0].source, 'telegram');
    // `local_` 은 "기록이 같은 턴을 돌려주면 이 줄을 지워라"는 표시다. 이게
    // 없으면 화면에 같은 말이 두 줄로 남는다.
    assert.equal(echoes[0].id?.startsWith('local_'), true);
  });
});

test('브라우저가 시킨 턴에는 같은 줄을 만들지 않는다', async () => {
  await withGateway(async ({ socket }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '평범한 요청',
    }));
    await settle();

    // 브라우저는 보낸 글을 이미 자기 화면에 그려 두었다. 서버가 하나 더
    // 흘려보내면 같은 말이 두 번 보인다.
    assert.equal(userEchoes(SESSION_ID).length, 0);
  });
});

test('예약·대기열로 들어온 턴에는 텔레그램 표시를 붙이지 않는다', async () => {
  await withGateway(async ({ runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '아침 점검' },
      { runtime } as never,
    );

    const echoes = userEchoes(SESSION_ID);
    assert.equal(echoes.length, 1);
    assert.equal(echoes[0].source, undefined);
  });
});

test('지난 턴에서 올라간 seq 때문에 이번 턴의 내용이 통째로 걸러지지 않는다', async () => {
  await withGateway(async ({ socket }) => {
    // 이전 턴이 seq 를 120 까지 올려 두었다고 하자. 클라이언트는 그 값을 들고
    // 온다 — `seq` 는 실행마다 1 부터 다시 세므로, 그대로 믿으면 이번 턴의
    // 이벤트가 전부 "이미 본 것"이 된다.
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
      origin: 'telegram',
    });
    assert.ok(run);
    run.writer.send({
      kind: 'text',
      role: 'user',
      content: '텔레그램에서 보낸 글',
      sessionId: SESSION_ID,
      provider: 'claude',
      id: 'local_test_1',
      timestamp: new Date().toISOString(),
    });

    socket.frames.length = 0;
    socket.emit('message', JSON.stringify({
      type: 'chat.subscribe',
      sessions: [{ sessionId: SESSION_ID, lastSeq: 120 }],
    }));
    await settle();

    const replayed = socket.frames.filter((frame) => frame.kind === 'text');
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].content, '텔레그램에서 보낸 글');
  });
});

test('구독하면 그 뒤의 이벤트가 이 소켓으로 흐른다', async () => {
  await withGateway(async ({ socket }) => {
    const run = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: 1,
      origin: 'telegram',
    });
    assert.ok(run);

    socket.emit('message', JSON.stringify({
      type: 'chat.subscribe',
      sessions: [{ sessionId: SESSION_ID, lastSeq: 0 }],
    }));
    await settle();

    socket.frames.length = 0;
    // 승인 요청이 이 길을 탄다. 붙어 있지 않으면 아무 데도 가지 못하고 55초
    // 뒤 거부로 끝난다 — 모델은 그걸 실패로 보고 같은 일을 다시 시도한다.
    run.writer.send({
      kind: 'permission_request',
      requestId: 'req-1',
      toolName: 'Bash',
      sessionId: SESSION_ID,
      provider: 'claude',
      id: 'perm-1',
      timestamp: new Date().toISOString(),
    });

    const permissions = socket.frames.filter((frame) => frame.kind === 'permission_request');
    assert.equal(permissions.length, 1);
    assert.equal(permissions[0].requestId, 'req-1');
  });
});
