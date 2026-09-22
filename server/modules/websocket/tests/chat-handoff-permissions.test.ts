import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb, closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  handleChatConnection,
  runDetachedChatTurn,
  TELEGRAM_PERMISSION_MODE_KEY,
  TELEGRAM_READ_ONLY_TOOLS,
  type TelegramPermissionMode,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * 폰으로 넘어간 턴에 얼마나 허용할지.
 *
 * 승인 창은 붙어 있는 브라우저에만 그려진다. 폰에는 아무것도 뜨지 않은 채 55초
 * 뒤 거부로 끝나므로, 설정 화면에서 고른 만큼만 폰에서 할 수 있다.
 *
 * 기본은 `ask` 다. 브라우저에서 그냥 보낸 턴은 이 설정과 무관하게 규칙 밖이다 —
 * 거기서는 물을 수 있다.
 */

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
  // 설정은 DB 에 있고 DB 는 이 함수가 만든다. 값을 미리 넣어 두지 않으면 테스트가
  // 저장 시점과 읽는 시점을 직접 맞춰야 한다.
  permissionMode?: TelegramPermissionMode,
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

    if (permissionMode) {
      appConfigDb.set(TELEGRAM_PERMISSION_MODE_KEY, permissionMode);
    }

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

test('전부 허용이면 텔레그램에서 보낸 턴은 승인을 묻지 않는다', async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '이어서 해줘', origin: 'telegram' },
      { runtime } as never,
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0].options.permissionMode, 'bypassPermissions');
    // Cursor 런타임은 최상위 플래그만 읽는다.
    assert.equal(runs[0].options.skipPermissions, true);
  }, 'full');
});

test('전부 허용이면 /bot 으로 넘긴 턴도 승인을 묻지 않는다', async () => {
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
  }, 'full');
});

test('읽기만 허용이면 읽기 도구만 통과시킨다', async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '코드 좀 훑어줘', origin: 'telegram' },
      { runtime } as never,
    );

    const toolsSettings = runs[0].options.toolsSettings as { allowedTools: string[] };
    assert.deepEqual(toolsSettings.allowedTools, TELEGRAM_READ_ONLY_TOOLS);
    // 나머지는 평소처럼 묻는다. 승인을 통째로 끄는 것이 아니다.
    assert.equal(runs[0].options.permissionMode, undefined);
    assert.equal(runs[0].options.skipPermissions, undefined);
  }, 'read');
});

test('읽기만 허용에 고치거나 실행하는 도구는 들어가지 않는다', async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '확인', origin: 'telegram' },
      { runtime } as never,
    );

    const { allowedTools } = runs[0].options.toolsSettings as { allowedTools: string[] };
    // `Bash` 는 읽는 명령도 있지만 같은 도구로 지울 수도 있어서 넣지 않는다.
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      assert.equal(allowedTools.includes(tool), false, `${tool} 이 들어가면 안 된다`);
    }
  }, 'read');
});

test('기본값은 묻기다', async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '이어서 해줘', origin: 'telegram' },
      { runtime } as never,
    );

    assert.equal(runs.length, 1);
    // 아무것도 고르지 않은 설치가 승인 없이 도는 쪽이면 안 된다.
    assert.equal(runs[0].options.permissionMode, undefined);
    assert.equal(runs[0].options.skipPermissions, undefined);
    assert.equal(runs[0].options.toolsSettings, undefined);
  });
});

test('저장된 값이 이상하면 묻기로 떨어진다', async () => {
  await withGateway(async ({ runs, runtime }) => {
    await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: '확인', origin: 'telegram' },
      { runtime } as never,
    );

    // 알 수 없는 값을 관대하게 읽으면 어느 쪽으로 도는지 아무도 모르게 된다.
    assert.equal(runs[0].options.permissionMode, undefined);
    assert.equal(runs[0].options.toolsSettings, undefined);
  }, 'nonsense' as never);
});

test('브라우저에서 그냥 보낸 턴은 설정과 무관하게 컴포저를 따른다', async () => {
  await withGateway(async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_ID,
      content: '평범한 요청',
      options: { permissionMode: 'default' },
    }));
    await settle();

    assert.equal(runs.length, 1);
    // 전부 허용으로 두어도 브라우저 턴은 그대로다. 거기서는 물을 수 있다.
    assert.equal(runs[0].options.permissionMode, 'default');
    assert.equal(runs[0].options.skipPermissions, undefined);
  }, 'full');
});

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
