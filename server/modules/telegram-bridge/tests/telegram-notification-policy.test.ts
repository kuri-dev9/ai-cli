import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { startTelegramBridge } from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import type { TelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { setSessionNotified } from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';

/**
 * 알림 정책: 기본은 조용히, 명시적으로 지정한 실행만 중계한다.
 *
 * 이 파일이 지키는 것은 "무엇이 가느냐"가 아니라 "무엇이 가지 않느냐"다.
 * 브라우저에서 대화할 때마다 폰이 울리면 알림 전체가 소음이 되고, 그러면
 * 정작 기다리던 회신을 놓친다. 반대로 텔레그램에서 보낸 작업의 회신이
 * 끊기면 브리지는 존재할 이유가 없다 — 그 둘을 함께 못 박아 둔다.
 */

const SESSION_ID = 'relay-session';
const CHAT_ID = 4242;

type Harness = {
  userId: number;
  /** 지금까지 텔레그램으로 나간 메시지들. */
  sent: string[];
  /** 프로바이더가 실제로 받은 프롬프트들. */
  prompts: string[];
  runTurn: (input: { content: string; origin?: 'web' | 'telegram' }) => Promise<void>;
};

/** 폴링도 네트워크도 없는 가짜 클라이언트. 보낸 메시지만 모은다. */
function createFakeClient(sent: string[]): TelegramClient {
  return {
    getUpdates: (_offset: number, signal?: AbortSignal) =>
      new Promise((resolve) => {
        // 중단될 때까지 매달려 있는다. 즉시 빈 배열을 돌려주면 폴링 루프가
        // 테스트가 끝날 때까지 CPU 를 태운다.
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
    getMe: async () => ({ username: 'test_bot' }),
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
    },
    requestTimeoutMs: 1_000,
  } as unknown as TelegramClient;
}

/** 이벤트는 `setImmediate` 로 미뤄져서 전달된다. 한 바퀴 돌려 준다. */
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

async function withBridge(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-relay-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const sent: string[] = [];
  const prompts: string[] = [];
  const runtime = {
    hasRuntime: () => true,
    // 이벤트를 하나도 내지 않는다. 그러면 dispatchRun 이 마무리로 terminal
    // `complete` 를 대신 내보내고, 그게 알림이 결정되는 지점이다.
    run: async (_provider: string, command: string) => {
      prompts.push(command);
    },
    abort: async () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  } as never;

  const bridge = startTelegramBridge({
    botToken: 'test-token',
    allowedChatIds: [CHAT_ID],
    runtime,
    client: createFakeClient(sent),
  });

  try {
    const user = userDb.createUser('bridge', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Bridge Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Bridge session');

    await runTest({
      userId: Number(user.id),
      sent,
      prompts,
      runTurn: async ({ content, origin }) => {
        await runDetachedChatTurn(
          { sessionId: SESSION_ID, userId: Number(user.id), content, origin },
          { runtime },
        );
        await flush();
      },
    });
  } finally {
    bridge.stop();
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

test('텔레그램에서 시작한 작업은 알림을 켜지 않아도 결과가 돌아온다', async () => {
  await withBridge(async ({ sent, runTurn }) => {
    await runTurn({ content: '테스트 돌려줘', origin: 'telegram' });

    assert.equal(sent.length, 1);
    assert.match(sent[0], /완료/);
  });
});

test('웹에서 시작한 작업은 기본적으로 아무것도 보내지 않는다', async () => {
  await withBridge(async ({ sent, runTurn }) => {
    await runTurn({ content: '브라우저에서 친 글' });

    assert.deepEqual(sent, []);
  });
});

test('시작 알림은 더 이상 발송되지 않는다', async () => {
  await withBridge(async ({ userId, sent, runTurn }) => {
    // 알림을 켠 세션에서도 마찬가지다. 완료만 알린다.
    setSessionNotified(userId, SESSION_ID, true);

    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    await flush();
    // `deepEqual(sent, [])` 로 쓰면 assert 의 타입 서술이 `sent` 를 `never[]` 로
    // 좁혀서, 아래에서 원소를 들여다보는 순간 타입 오류가 난다.
    assert.equal(sent.length, 0, '시작 시점에는 아무것도 나가지 않아야 한다');

    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    await flush();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /완료/);

    // 완료 알림 하나뿐이라는 것이 이 테스트의 핵심이다.
    await runTurn({ content: '두 번째' });
    assert.equal(sent.length, 2);
    assert.ok(sent.every((message) => !message.includes('작업을 시작')));
  });
});

test('/bot 을 붙인 웹 작업은 결과가 가고, 접두어는 모델에게 넘어가지 않는다', async () => {
  await withBridge(async ({ sent, prompts, runTurn }) => {
    await runTurn({ content: '/bot 테스트 돌려줘' });

    // 모델이 받은 것은 접두어를 뗀 본문뿐이다.
    assert.deepEqual(prompts, ['테스트 돌려줘']);

    // 이어받았다는 안내 한 번 + 완료 한 번.
    assert.equal(sent.length, 2);
    assert.match(sent[0], /이어받았습니다/);
    assert.match(sent[1], /완료/);

    // 안내는 대화당 한 번뿐이다. 같은 세션을 다시 /bot 으로 불러도 쌓이지 않는다.
    await runTurn({ content: '/bot 한 번 더' });
    assert.equal(sent.length, 3);
    assert.match(sent[2], /완료/);
  });
});

test('세션 알림을 켜 두면 웹 작업도 끝날 때마다 간다', async () => {
  await withBridge(async ({ userId, sent, runTurn }) => {
    setSessionNotified(userId, SESSION_ID, true);
    await runTurn({ content: '첫 번째' });
    assert.equal(sent.length, 1);

    await runTurn({ content: '두 번째' });
    assert.equal(sent.length, 2);

    // 끄면 다시 조용해진다.
    setSessionNotified(userId, SESSION_ID, false);
    await runTurn({ content: '세 번째' });
    assert.equal(sent.length, 2);
  });
});

test('알림을 켠 세션이 아니면 다른 세션의 웹 작업은 조용하다', async () => {
  await withBridge(async ({ userId, sent, runTurn }) => {
    setSessionNotified(userId, 'some-other-session', true);

    await runTurn({ content: '이 세션은 켜 두지 않았다' });

    assert.deepEqual(sent, []);
  });
});
