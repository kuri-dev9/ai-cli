import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  closeTelegramBridge,
  initializeTelegramBridge,
  isTelegramBridgeRunning,
} from '@/modules/telegram-bridge/index.js';
import { createTelegramRouter } from '@/modules/telegram-bridge/telegram.routes.js';
import {
  readTelegramSettings,
  writeTelegramSettings,
} from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import { AppError } from '@/shared/utils.js';

const PLAINTEXT_TOKEN = '123456789:AAHrealSecretTokenValue';

type SettingsResponse = {
  enabled: boolean;
  botToken: string;
  hasToken: boolean;
  allowedChatIds: number[];
  fromEnvironment: boolean;
  running: boolean;
  botUsername: string | null;
};

/**
 * 설정은 DB 에 들어가므로 테스트마다 빈 DB 를 새로 판다. 환경변수도 같이
 * 비워 둔다 — 개발자 로컬의 `.env` 가 폴백으로 새어 들어오면 "DB 가 우선"을
 * 확인하는 테스트가 통과하는지 실패하는지가 그 사람 환경에 달리게 된다.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-settings-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeTelegramBridge();
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

/** 브리지도 텔레그램도 부르지 않는 라우터. 라우트 계약만 본다. */
function createTestRouter(overrides: Parameters<typeof createTelegramRouter>[0] = {}) {
  const restarts: number[] = [];
  const router = createTelegramRouter({
    restartBridge: () => { restarts.push(Date.now()); },
    isRunning: () => false,
    checkConnection: async () => ({ ok: false, error: 'not stubbed' }),
    ...overrides,
  });
  return { router, restarts };
}

async function withServer(
  router: express.Router,
  runTest: (request: (
    method: string,
    routePath: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/telegram', router);
  // 서버 진입점과 같은 에러 처리. 400 이 실제로 400 으로 나가는지 보려면 필요하다.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(status).json({ success: false, error: { message } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  try {
    await runTest(async (method, routePath, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/telegram${routePath}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('설정 조회는 평문 토큰을 내보내지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [12345678], enabled: true });
    const { router } = createTestRouter();

    await withServer(router, async (request) => {
      const { status, body } = await request('GET', '/settings');
      const settings = body as unknown as SettingsResponse;

      assert.equal(status, 200);
      assert.equal(settings.botToken, '123456789:••••••••');
      assert.equal(settings.hasToken, true);
      assert.equal(settings.enabled, true);
      assert.deepEqual(settings.allowedChatIds, [12345678]);
      assert.equal(settings.fromEnvironment, false);
      assert.equal(settings.running, false);
      assert.equal(settings.botUsername, null);
      assert.ok(!JSON.stringify(body).includes(PLAINTEXT_TOKEN));
    });
  });
});

test('마스킹된 토큰을 그대로 저장하면 기존 토큰이 살아남는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [12345678] });
    const { router, restarts } = createTestRouter();

    await withServer(router, async (request) => {
      const { status, body } = await request('PUT', '/settings', {
        botToken: '123456789:••••••••',
        allowedChatIds: [999],
      });

      assert.equal(status, 200);
      // 토큰 칸을 손대지 않은 저장이므로 다른 항목만 반영돼야 한다.
      assert.deepEqual((body as unknown as SettingsResponse).allowedChatIds, [999]);
      assert.equal(readTelegramSettings().botToken, PLAINTEXT_TOKEN);
      assert.equal(restarts.length, 1);
    });
  });
});

test('평문 토큰을 저장해도 응답에는 마스킹된 값만 실린다', async () => {
  await withIsolatedDatabase(async () => {
    const { router } = createTestRouter();

    await withServer(router, async (request) => {
      const { status, body } = await request('PUT', '/settings', {
        botToken: PLAINTEXT_TOKEN,
        allowedChatIds: [12345678],
        enabled: true,
      });

      assert.equal(status, 200);
      assert.ok(!JSON.stringify(body).includes(PLAINTEXT_TOKEN));
      assert.equal((body as unknown as SettingsResponse).botToken, '123456789:••••••••');
      assert.equal(readTelegramSettings().botToken, PLAINTEXT_TOKEN);
    });
  });
});

test('빈 문자열은 토큰 삭제로 본다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN });
    const { router } = createTestRouter();

    await withServer(router, async (request) => {
      const { body } = await request('PUT', '/settings', { botToken: '   ' });

      assert.equal((body as unknown as SettingsResponse).hasToken, false);
      assert.equal(readTelegramSettings().botToken, '');
    });
  });
});

test('chat id 가 숫자 배열이 아니면 400 이고 아무것도 저장하지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ allowedChatIds: [12345678] });
    const { router, restarts } = createTestRouter();

    await withServer(router, async (request) => {
      const rejected = await request('PUT', '/settings', { allowedChatIds: ['12345678'] });
      assert.equal(rejected.status, 400);

      const notAnArray = await request('PUT', '/settings', { allowedChatIds: 12345678 });
      assert.equal(notAnArray.status, 400);

      const badFlag = await request('PUT', '/settings', { enabled: 'yes' });
      assert.equal(badFlag.status, 400);

      assert.deepEqual(readTelegramSettings().allowedChatIds, [12345678]);
      assert.equal(restarts.length, 0);
    });
  });
});

test('연결 확인에 성공하면 봇 이름이 남아 다음 조회에 실린다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN });
    const checkedTokens: string[] = [];
    const { router } = createTestRouter({
      checkConnection: async (botToken: string) => {
        checkedTokens.push(botToken);
        return { ok: true, botUsername: 'my_bot' };
      },
    });

    await withServer(router, async (request) => {
      const tested = await request('POST', '/test', {});
      assert.equal(tested.status, 200);
      assert.deepEqual(tested.body, { ok: true, botUsername: 'my_bot' });
      // 본문에 토큰이 없으면 저장된 토큰으로 확인한다.
      assert.deepEqual(checkedTokens, [PLAINTEXT_TOKEN]);

      const { body } = await request('GET', '/settings');
      assert.equal((body as unknown as SettingsResponse).botUsername, 'my_bot');
    });
  });
});

test('다른 봇으로 토큰을 바꾸면 남아 있던 봇 이름은 따라오지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN });
    const { router } = createTestRouter({
      checkConnection: async () => ({ ok: true, botUsername: 'my_bot' }),
    });

    await withServer(router, async (request) => {
      await request('POST', '/test', {});
      await request('PUT', '/settings', { botToken: '987654321:AAHanotherToken' });

      const { body } = await request('GET', '/settings');
      assert.equal((body as unknown as SettingsResponse).botUsername, null);
    });
  });
});

test('연결 확인이 실패해도 200 에 이유를 담아 돌려준다', async () => {
  await withIsolatedDatabase(async () => {
    const { router } = createTestRouter({
      checkConnection: async () => ({ ok: false, error: 'Telegram getMe failed: Unauthorized' }),
    });

    await withServer(router, async (request) => {
      const { status, body } = await request('POST', '/test', { botToken: PLAINTEXT_TOKEN });

      assert.equal(status, 200);
      assert.deepEqual(body, { ok: false, error: 'Telegram getMe failed: Unauthorized' });
    });
  });
});

test('확인할 토큰이 아예 없으면 400 이다', async () => {
  await withIsolatedDatabase(async () => {
    const { router } = createTestRouter();

    await withServer(router, async (request) => {
      const { status } = await request('POST', '/test', {});
      assert.equal(status, 400);
    });
  });
});

test('enabled 가 꺼져 있으면 토큰이 멀쩡해도 브리지를 켜지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({
      botToken: PLAINTEXT_TOKEN,
      allowedChatIds: [12345678],
      enabled: false,
    });

    initializeTelegramBridge({} as never);

    assert.equal(isTelegramBridgeRunning(), false);
  });
});

test('화이트리스트가 비어 있으면 브리지를 켜지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [], enabled: true });

    initializeTelegramBridge({} as never);

    // 토큰만 있고 허용된 대화가 없으면, 봇을 찾아낸 누구나 명령을 돌릴 수 있다.
    assert.equal(isTelegramBridgeRunning(), false);
  });
});

test('토큰이 없으면 브리지를 켜지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    writeTelegramSettings({ botToken: '', allowedChatIds: [12345678], enabled: true });

    initializeTelegramBridge({} as never);

    assert.equal(isTelegramBridgeRunning(), false);
  });
});

test('DB 설정이 환경변수보다 우선한다', async () => {
  await withIsolatedDatabase(async () => {
    process.env.TELEGRAM_BOT_TOKEN = '111111:envToken';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '42';
    writeTelegramSettings({ botToken: PLAINTEXT_TOKEN, allowedChatIds: [12345678] });

    const settings = readTelegramSettings();

    assert.equal(settings.botToken, PLAINTEXT_TOKEN);
    assert.deepEqual(settings.allowedChatIds, [12345678]);
    assert.equal(settings.fromEnvironment, false);
  });
});

test('DB 가 비어 있을 때만 환경변수가 폴백으로 쓰인다', async () => {
  await withIsolatedDatabase(async () => {
    process.env.TELEGRAM_BOT_TOKEN = '111111:envToken';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '42, 43';

    const settings = readTelegramSettings();

    assert.equal(settings.botToken, '111111:envToken');
    assert.deepEqual(settings.allowedChatIds, [42, 43]);
    assert.equal(settings.fromEnvironment, true);
  });
});

test('설정이 갖춰지면 브리지가 뜨고, 재시작하면 새 설정으로 다시 뜬다', async () => {
  await withIsolatedDatabase(async () => {
    const originalFetch = globalThis.fetch;
    // 폴링이 실제로 나가지 않도록, 중단될 때까지 매달려 있는 fetch 를 끼운다.
    // 텔레그램 주소만 가로챈다 — 전부 가로채면 이 테스트가 자기 라우터에 거는
    // 요청까지 같이 막혀서 영원히 기다리게 된다.
    globalThis.fetch = ((input: Parameters<typeof originalFetch>[0], init?: RequestInit) => {
      if (!String(input).startsWith('https://api.telegram.org')) {
        return originalFetch(input, init);
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof fetch;

    try {
      writeTelegramSettings({
        botToken: PLAINTEXT_TOKEN,
        allowedChatIds: [12345678],
        enabled: true,
      });

      initializeTelegramBridge({} as never);
      assert.equal(isTelegramBridgeRunning(), true);

      // 여기서는 진짜 브리지를 껐다 켜는 경로를 그대로 쓴다.
      const router = createTelegramRouter({ isRunning: isTelegramBridgeRunning });

      await withServer(router, async (request) => {
        const { body } = await request('PUT', '/settings', { enabled: false });

        // 저장한 설정이 바로 반영돼야 한다. 재시작을 시켜야 꺼지면, 화면에서
        // 끈 뒤에도 옛 토큰으로 계속 폴링하게 된다.
        assert.equal((body as unknown as SettingsResponse).running, false);
        assert.equal(isTelegramBridgeRunning(), false);
      });
    } finally {
      closeTelegramBridge();
      globalThis.fetch = originalFetch;
    }
  });
});
