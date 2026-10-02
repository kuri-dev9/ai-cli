import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { startTelegramBridge } from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import type { TelegramClient, TelegramUpdate } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { readBridgeState } from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

/**
 * 재시작 사이에 offset 이 사라지면 무슨 일이 나는지를 잡는 테스트다.
 *
 * 텔레그램의 `getUpdates` 는 offset 보다 작은 update_id 를 넘기기 전까지는
 * 같은 갱신을 계속 돌려준다 — 그래서 가짜 서버도 "한 번 받으면 사라지는"
 * 큐가 아니라 "확인받은 offset 아래는 숨기는" 저장소로 만든다. 프로세스가
 * 메시지를 처리한 직후, 다음 확인 호출이 나가기도 전에 재시작하면 어떻게
 * 되는지가 바로 이 간극이다.
 */

const SESSION_ID = 'poll-offset-session';
const CHAT_ID = 9911;

/** 텔레그램 서버 흉내. offset 아래로 확인받기 전까지는 같은 갱신을 계속 준다. */
function createFakeTelegramServer(seedUpdates: TelegramUpdate[]) {
  return {
    updates: seedUpdates,
    createClient(): TelegramClient {
      return {
        getUpdates: (offset: number, signal?: AbortSignal) => {
          const pending = this.updates.filter((update) => update.updateId >= offset);
          if (pending.length > 0) {
            return Promise.resolve(pending);
          }
          return new Promise((resolve) => {
            signal?.addEventListener('abort', () => resolve([]), { once: true });
          });
        },
        getMe: async () => ({ username: 'test_bot' }),
        sendMessage: async () => {},
        requestTimeoutMs: 1_000,
      } as unknown as TelegramClient;
    },
  };
}

const flush = async (rounds = 5): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
};

async function withIsolatedDatabase(
  runTest: (context: { userId: number }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-poll-offset-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('bridge', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Bridge Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Bridge session');
    await runTest({ userId: Number(user.id) });
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

test('재시작 직후에도 이미 받은 갱신을 대기열에 다시 넣지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = {
      hasRuntime: () => true,
      run: async () => {},
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    } as never;

    // 세션을 미리 "작업 중"으로 만들어 둔다 — 명령이 즉시 실행되지 않고
    // 대기열로 가야, 재시작마다 같은 메시지가 몇 건 쌓였는지로 중복을 잰다.
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    // 첫 갱신은 구독 명령이어야 뒤이은 프롬프트가 대기열로 간다. 두 번째
    // update 로 실제 프롬프트를 보낸다.
    const server = createFakeTelegramServer([
      { updateId: 500, message: { messageId: 1, chatId: CHAT_ID, text: '/watch 1', files: [], mediaGroupId: null } },
      { updateId: 501, message: { messageId: 2, chatId: CHAT_ID, text: '확인해줘', files: [], mediaGroupId: null } },
    ]);

    const bridgeA = startTelegramBridge({
      botToken: 'test-token',
      allowedChatIds: [CHAT_ID],
      runtime,
      client: server.createClient(),
    });

    await flush();
    // 재시작을 흉내 낸다 — 다음 getUpdates 호출(=확인)이 나가기 전에 끊는다.
    bridgeA.stop();
    await flush();

    assert.equal(
      sessionDraftsDb.countQueuedMessages(userId, SESSION_ID),
      1,
      '재시작 전에 이미 대기열에 한 건 들어가 있어야 한다',
    );
    assert.equal(
      readBridgeState(userId).lastUpdateOffset,
      502,
      '처리한 갱신 뒤로 offset 이 디스크에 남아 있어야 한다',
    );

    // 텔레그램은 이 update 를 여전히 돌려줄 수 있다 — 위에서 다음 확인 호출이
    // 나가지 못하게 끊었으니까. 재시작한 브리지가 디스크의 offset 부터
    // 이어받지 못하면 이 두 건을 또 받아 대기열에 하나 더 쌓는다.
    const bridgeB = startTelegramBridge({
      botToken: 'test-token',
      allowedChatIds: [CHAT_ID],
      runtime,
      client: server.createClient(),
    });

    await flush();
    bridgeB.stop();

    assert.equal(
      sessionDraftsDb.countQueuedMessages(userId, SESSION_ID),
      1,
      '재시작한 브리지가 같은 메시지를 대기열에 중복으로 넣으면 안 된다',
    );
  });
});
