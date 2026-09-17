import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// express 의 Response 를 그대로 들이면 전역 `Response`(fetch) 가 가려진다.
// 이 파일은 텔레그램 응답을 흉내 내느라 전역 쪽을 더 많이 쓴다.
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { createTelegramRouter } from '@/modules/telegram-bridge/telegram.routes.js';
import { discoverTelegramChats } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { writeTelegramSettings } from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import { AppError } from '@/shared/utils.js';

/**
 * "내 chat id 찾기"가 지켜야 하는 것들.
 *
 * 가장 중요한 것은 offset 을 전진시키지 않는 것이다 — 이 조회가 갱신을
 * 확인(confirm)해 버리면 대기 중이던 메시지가 텔레그램에서 사라지고, 나중에
 * 브리지를 켜도 그 명령들은 영영 오지 않는다. 테스트가 이 한 줄을 지킨다.
 */

const PLAINTEXT_TOKEN = '123456789:AAHrealSecretTokenValue';

type DiscoveryResponse = {
  chats: Array<{
    chatId: number;
    name: string;
    username: string;
    lastText: string;
    isGroup: boolean;
  }>;
  bridgeRunning: boolean;
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-discover-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore('DATABASE_PATH', previousDatabasePath);
    restore('TELEGRAM_BOT_TOKEN', previousToken);
    restore('TELEGRAM_ALLOWED_CHAT_IDS', previousChatIds);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withServer(
  router: express.Router,
  runTest: (request: (
    method: string,
    routePath: string,
  ) => Promise<{ status: number; body: Record<string, unknown>; raw: string }>) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/telegram', router);
  app.use((error: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(status).json({ success: false, error: { message } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    await runTest(async (method, routePath) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/telegram${routePath}`, { method });
      const raw = await response.text();
      return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 텔레그램 주소만 가로채고 나머지(테스트 서버로 거는 요청)는 그대로 둔다. */
function stubTelegram(handler: (url: string, init: RequestInit | undefined) => Response) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = ((input: Parameters<typeof originalFetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.telegram.org')) {
      return originalFetch(input, init);
    }
    calls.push({
      url,
      body: typeof init?.body === 'string'
        ? JSON.parse(init.body) as Record<string, unknown>
        : {},
    });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const telegramOk = (result: unknown) => new Response(
  JSON.stringify({ ok: true, result }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const rawUpdate = (updateId: number, chat: Record<string, unknown>, text: string) => ({
  update_id: updateId,
  message: { message_id: updateId, text, chat },
});

test('조회는 offset 을 전진시키지 않고 즉시 돌아온다', async () => {
  const stub = stubTelegram(() => telegramOk([]));

  try {
    await discoverTelegramChats(PLAINTEXT_TOKEN);

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0]!;
    assert.ok(call.url.endsWith('/getUpdates'));

    // offset 을 넘기면 그 아래 갱신이 텔레그램에서 확인 처리돼 사라진다.
    // 브리지가 나중에 그 메시지들을 받지 못하게 되므로 절대 넣지 않는다.
    assert.equal('offset' in call.body, false);

    // long polling 이 아니다. 버튼 하나에 30 초를 기다리게 할 수 없다.
    assert.equal(call.body.timeout, 0);
    assert.deepEqual(call.body.allowed_updates, ['message']);
  } finally {
    stub.restore();
  }
});

test('같은 chatId 는 가장 최근 메시지로 하나로 합친다', async () => {
  const stub = stubTelegram(() => telegramOk([
    rawUpdate(1, { id: 12345678, type: 'private', first_name: '길동', last_name: '홍' }, '처음'),
    rawUpdate(2, { id: 99, type: 'private', first_name: '다른' }, '다른 사람'),
    rawUpdate(3, { id: 12345678, type: 'private', first_name: '길동', last_name: '홍', username: 'gildong' }, '나중'),
  ]));

  try {
    const { chats, conflict } = await discoverTelegramChats(PLAINTEXT_TOKEN);

    assert.equal(conflict, false);
    assert.equal(chats.length, 2);

    const merged = chats.find((chat) => chat.chatId === 12345678)!;
    assert.equal(merged.lastText, '나중');
    assert.equal(merged.name, '길동 홍');
    assert.equal(merged.username, 'gildong');
    assert.equal(merged.isGroup, false);
  } finally {
    stub.restore();
  }
});

test('이름이 없으면 username 으로, 그룹은 음수 id 로 표시한다', async () => {
  const stub = stubTelegram(() => telegramOk([
    rawUpdate(1, { id: 555, type: 'private', username: 'onlyname' }, '안녕'),
    rawUpdate(2, { id: -1001, type: 'group', title: '팀 채널' }, '그룹 메시지'),
    rawUpdate(3, { id: 777, type: 'private' }, '이름 없음'),
  ]));

  try {
    const { chats } = await discoverTelegramChats(PLAINTEXT_TOKEN);

    const byUsername = chats.find((chat) => chat.chatId === 555)!;
    assert.equal(byUsername.name, 'onlyname');

    const group = chats.find((chat) => chat.chatId === -1001)!;
    assert.equal(group.isGroup, true);
    assert.equal(group.name, '팀 채널');

    const nameless = chats.find((chat) => chat.chatId === 777)!;
    assert.equal(nameless.name, '');
  } finally {
    stub.restore();
  }
});

test('409 Conflict 는 실패가 아니라 "브리지가 물고 있음"으로 돌려준다', async () => {
  const stub = stubTelegram(() => new Response(
    JSON.stringify({
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  ));

  try {
    const { chats, conflict } = await discoverTelegramChats(PLAINTEXT_TOKEN);

    assert.equal(conflict, true);
    assert.deepEqual(chats, []);
  } finally {
    stub.restore();
  }
});

test('409 가 아닌 실패는 예외로 올리되 토큰은 문구에 남기지 않는다', async () => {
  const stub = stubTelegram(() => new Response(
    JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized (${PLAINTEXT_TOKEN})` }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  ));

  try {
    await assert.rejects(
      () => discoverTelegramChats(PLAINTEXT_TOKEN),
      (error: Error) => {
        assert.ok(!error.message.includes(PLAINTEXT_TOKEN));
        assert.match(error.message, /Unauthorized/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('저장된 토큰이 없으면 400 이고 텔레그램을 부르지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    let called = 0;
    const router = createTelegramRouter({
      isRunning: () => false,
      restartBridge: () => {},
      discoverChats: async () => {
        called += 1;
        return { chats: [], conflict: false };
      },
    });

    await withServer(router, async (request) => {
      const { status } = await request('GET', '/discover-chats');

      assert.equal(status, 400);
      assert.equal(called, 0);
    });
  });
});

test('브리지가 폴링 중이면 텔레그램을 부르지 않고 bridgeRunning 을 알린다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [], enabled: true });

    let called = 0;
    const router = createTelegramRouter({
      // 브리지가 이미 getUpdates 를 붙들고 있는 상태.
      isRunning: () => true,
      restartBridge: () => {},
      discoverChats: async () => {
        called += 1;
        return { chats: [], conflict: false };
      },
    });

    await withServer(router, async (request) => {
      const { status, body } = await request('GET', '/discover-chats');
      const discovery = body as unknown as DiscoveryResponse;

      assert.equal(status, 200);
      assert.equal(discovery.bridgeRunning, true);
      assert.deepEqual(discovery.chats, []);
      // 같은 토큰으로 두 곳에서 폴링하면 브리지 쪽이 끊길 수 있어 아예 부르지 않는다.
      assert.equal(called, 0);
    });
  });
});

test('텔레그램이 409 로 거절하면 라우트도 bridgeRunning 으로 내려준다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [], enabled: true });

    const router = createTelegramRouter({
      isRunning: () => false,
      restartBridge: () => {},
      discoverChats: async () => ({ chats: [], conflict: true }),
    });

    await withServer(router, async (request) => {
      const { status, body } = await request('GET', '/discover-chats');

      assert.equal(status, 200);
      assert.equal((body as unknown as DiscoveryResponse).bridgeRunning, true);
    });
  });
});

test('찾은 목록을 돌려주되 응답 어디에도 토큰은 없다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [], enabled: true });

    const usedTokens: string[] = [];
    const router = createTelegramRouter({
      isRunning: () => false,
      restartBridge: () => {},
      discoverChats: async (botToken: string) => {
        usedTokens.push(botToken);
        return {
          chats: [{
            chatId: 12345678,
            name: '홍길동',
            username: 'gildong',
            lastText: '안녕',
            isGroup: false,
          }],
          conflict: false,
        };
      },
    });

    await withServer(router, async (request) => {
      const { status, body, raw } = await request('GET', '/discover-chats');
      const discovery = body as unknown as DiscoveryResponse;

      assert.equal(status, 200);
      assert.equal(discovery.bridgeRunning, false);
      assert.deepEqual(discovery.chats, [{
        chatId: 12345678,
        name: '홍길동',
        username: 'gildong',
        lastText: '안녕',
        isGroup: false,
      }]);

      // 저장된 토큰으로 조회하지만, 그 토큰이 응답에 실려 나가서는 안 된다.
      assert.deepEqual(usedTokens, [PLAINTEXT_TOKEN]);
      assert.ok(!raw.includes(PLAINTEXT_TOKEN));
      assert.ok(!raw.includes('AAHrealSecretTokenValue'));
    });
  });
});
