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
import { claimRelayHandoff, shouldRelayCompletion } from '@/modules/telegram-bridge/index.js';
import {
  readBridgeState,
  writeBridgeState,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'handoff-session';
const OTHER_SESSION_ID = 'handoff-other-session';

async function withIsolatedDatabase(
  runTest: (context: { userId: number; projectPath: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-handoff-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('handoff', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Handoff Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Handoff session');
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', tempDirectory, 'Other session');
    await runTest({ userId: Number(user.id), projectPath: tempDirectory });
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

/** 한 턴을 등록한다. `/bot` 여부와 출처만 이 테스트의 관심사다. */
function startRun(
  sessionId: string,
  options: { relayRequested?: boolean; origin?: 'web' | 'telegram' } = {},
): void {
  chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: 1,
    origin: options.origin ?? 'web',
    relayRequested: options.relayRequested ?? false,
  });
}

test('/bot 을 붙인 웹 실행은 그 세션을 텔레그램으로 넘겨받는다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    startRun(SESSION_ID, { relayRequested: true });

    assert.equal(claimRelayHandoff(SESSION_ID), true);

    const state = readBridgeState(userId);
    // 폰에서 그냥 답장했을 때 이 대화로 들어가야 하므로 명령 대상이 옮겨진다.
    assert.equal(state.watchedSessionId, SESSION_ID);
    assert.ok(state.notifiedSessionIds.includes(SESSION_ID));
  });
});

test('넘겨받은 대화는 /watch 로 고른 다른 세션을 밀어낸다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    writeBridgeState(userId, { watchedSessionId: OTHER_SESSION_ID });
    startRun(SESSION_ID, { relayRequested: true });

    assert.equal(claimRelayHandoff(SESSION_ID), true);
    assert.equal(readBridgeState(userId).watchedSessionId, SESSION_ID);
  });
});

test('이미 넘겨받은 대화는 다시 넘겨받지 않는다', async () => {
  await withIsolatedDatabase(() => {
    startRun(SESSION_ID, { relayRequested: true });
    assert.equal(claimRelayHandoff(SESSION_ID), true);

    chatRunRegistry.clearAll();
    startRun(SESSION_ID, { relayRequested: true });
    // 두 번째부터 false 여야 한다. 아니면 `/bot` 을 쓸 때마다 같은 안내가 쌓인다.
    assert.equal(claimRelayHandoff(SESSION_ID), false);
  });
});

test('/bot 없는 웹 실행은 아무것도 넘겨받지 않는다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    startRun(SESSION_ID);

    assert.equal(claimRelayHandoff(SESSION_ID), false);
    assert.equal(readBridgeState(userId).watchedSessionId, null);
  });
});

test('텔레그램에서 시작한 실행은 넘겨받을 것이 없다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    writeBridgeState(userId, { watchedSessionId: OTHER_SESSION_ID });
    startRun(SESSION_ID, { relayRequested: true, origin: 'telegram' });

    // 텔레그램에서 온 실행은 이미 보고 있는 세션이라는 뜻이다. 여기서 대상을
    // 옮기면 사용자가 고르지 않은 세션으로 말없이 갈아타게 된다.
    assert.equal(claimRelayHandoff(SESSION_ID), false);
    assert.equal(readBridgeState(userId).watchedSessionId, OTHER_SESSION_ID);
  });
});

test('넘겨받은 뒤에는 그 세션의 웹 실행도 회신 대상이 된다', async () => {
  await withIsolatedDatabase(() => {
    startRun(SESSION_ID, { relayRequested: true });
    claimRelayHandoff(SESSION_ID);

    // 인계 다음 턴 — `/bot` 없이 웹에서 돌려도 결과가 폰으로 가야 한다.
    chatRunRegistry.clearAll();
    startRun(SESSION_ID);
    assert.equal(shouldRelayCompletion(SESSION_ID), true);

    // 넘긴 적 없는 다른 대화는 그대로 조용하다.
    startRun(OTHER_SESSION_ID);
    assert.equal(shouldRelayCompletion(OTHER_SESSION_ID), false);
  });
});
