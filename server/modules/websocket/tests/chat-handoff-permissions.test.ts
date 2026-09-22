import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  handleChatConnection,
  runDetachedChatTurn,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * 폰으로 넘어간 턴을 승인 없이 돌리는 스위치.
 *
 * 승인 요청은 붙어 있는 브라우저에만 그려진다. 텔레그램에는 아무것도 뜨지 않은
 * 채 55초 뒤 거부로 끝나므로, 켜 두면 아예 묻지 않고 돌린다.
 *
 * 다만 기본은 꺼짐이다. 켜면 폰에서 보낸 한 줄이 파일 삭제까지 아무도 승인하지
 * 않은 채 실행하므로, 설치한 사람이 `.env` 에서 직접 켜야 한다. 브라우저에서
 * 그냥 보낸 턴은 스위치와 무관하게 이 규칙 밖이다 — 거기서는 물을 수 있다.
 */

/** 이 파일이 환경변수를 갈아 끼우므로, 다른 테스트에 새지 않도록 되돌린다. */
function withBypass(enabled: boolean, run: () => Promise<void>): () => Promise<void> {
  return async () => {
    const previous = process.env.TELEGRAM_SKIP_PERMISSIONS;
    if (enabled) {
      process.env.TELEGRAM_SKIP_PERMISSIONS = 'true';
    } else {
      delete process.env.TELEGRAM_SKIP_PERMISSIONS;
    }
    try {
      await run();
    } finally {
      if (previous === undefined) {
        delete process.env.TELEGRAM_SKIP_PERMISSIONS;
      } else {
        process.env.TELEGRAM_SKIP_PERMISSIONS = previous;
      }
    }
  };
}

const SESSION_ID = 'handoff-permission-session';

type RunCall = { options: Record<string, unknown> };

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.send = () => {};
  return socket;
}

async function withGateway(
  runTest: (context: {
    socket: ReturnType<typeof createFakeSocket>;
    runs: RunCall[];
    runtime: unknown;
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-handoff-perms-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const socket = createFakeSocket();
  const runtime = {
    hasRuntime: () => true,
    run: async (_provider: string, _command: string, options: Record<string, unknown>) => {
      runs.push({ options });
    },
  };

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Handoff session', now, now, null);

    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime } as never);
    await runTest({ socket, runs, runtime });
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

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('켜 두면 텔레그램에서 보낸 턴은 승인을 묻지 않는다', withBypass(true, async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '이어서 해줘', origin: 'telegram' },
      { runtime } as never,
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.permissionMode, 'bypassPermissions');
    // Cursor 런타임은 최상위 플래그만 읽는다.
    assert.equal(runs[0].options.skipPermissions, true);
  });
}));

test('켜 두면 /bot 으로 넘긴 턴도 승인을 묻지 않는다', withBypass(true, async () => {
  await withGateway(async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '/bot 나가 있는 동안 돌려줘',
    }));
    await settle();

    assert.equal(runs.length, 1);
    // `/bot` 은 "브라우저를 떠난다"는 뜻이다. 떠난 뒤에 물으면 답할 사람이 없다.
    assert.equal(runs[0].options.permissionMode, 'bypassPermissions');
    assert.equal(runs[0].options.skipPermissions, true);
  });
}));

test('꺼 두면 텔레그램에서 보낸 턴도 평소처럼 승인을 묻는다', withBypass(false, async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '이어서 해줘', origin: 'telegram' },
      { runtime } as never,
    );

    assert.equal(runs.length, 1);
    // 기본값이다. 켜는 것은 설치한 사람의 몫이고, 받는 사람이 모르는 채로
    // 위험을 떠안는 쪽이 기본이면 안 된다.
    assert.equal(runs[0].options.permissionMode, undefined);
    assert.equal(runs[0].options.skipPermissions, undefined);
  });
}));

test('꺼 두면 /bot 으로 넘긴 턴도 평소처럼 승인을 묻는다', withBypass(false, async () => {
  await withGateway(async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '/bot 나가 있는 동안 돌려줘',
    }));
    await settle();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.permissionMode, undefined);
  });
}));

test('true 가 아닌 값은 켠 것으로 보지 않는다', withBypass(false, async () => {
  process.env.TELEGRAM_SKIP_PERMISSIONS = '1';
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '확인', origin: 'telegram' },
      { runtime } as never,
    );

    // 어중간하게 켜지면 켠 줄 모르고 쓰게 된다. 정확히 true 만 받는다.
    assert.equal(runs[0].options.permissionMode, undefined);
  });
}));

test('브라우저에서 그냥 보낸 턴은 컴포저가 고른 그대로 간다', withBypass(true, async () => {
  await withGateway(async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '평범한 요청',
      options: { permissionMode: 'default' },
    }));
    await settle();

    assert.equal(runs.length, 1);
    // 여기서는 승인 창이 뜬다. 뜰 수 있는 자리의 선택은 건드리지 않는다.
    // 스위치를 켜 두어도 브라우저 턴은 그대로다. 거기서는 물을 수 있다.
    assert.equal(runs[0].options.permissionMode, 'default');
    assert.equal(runs[0].options.skipPermissions, undefined);
  });
}));

test('/unbot 만 보내면 턴을 돌리지 않는다', async () => {
  await withGateway(async ({ socket, runs }) => {
    const released: string[] = [];
    const unsubscribe = chatRunRegistry.onRelayReleased((sessionId) => released.push(sessionId));

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '/unbot',
    }));
    await settle();

    // 놓기만 하려던 사람에게 빈 프롬프트로 한 턴을 돌려 주지 않는다.
    assert.equal(runs.length, 0);
    assert.deepEqual(released, [SESSION_ID]);
    unsubscribe();
  });
});

test('/unbot 뒤에 할 말이 있으면 놓고 나서 그 턴을 돌린다', async () => {
  await withGateway(async ({ socket, runs }) => {
    const released: string[] = [];
    const unsubscribe = chatRunRegistry.onRelayReleased((sessionId) => released.push(sessionId));

    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '/unbot 이제 브라우저에서 계속하자',
    }));
    await settle();

    assert.deepEqual(released, [SESSION_ID]);
    assert.equal(runs.length, 1);
    unsubscribe();
    // 접두어는 모델에게 가지 않는다.
    assert.equal(runs[0].options.permissionMode, undefined);
  });
});
