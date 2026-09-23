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
import { isSessionHandedToTelegram, shouldRelayCompletion } from '@/modules/telegram-bridge/index.js';
import {
  readBridgeState,
  setSessionHandedOver,
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

/** 한 턴을 등록한다. 출처만 이 테스트의 관심사다. */
function startRun(sessionId: string, origin: 'web' | 'telegram' = 'web'): void {
  chatRunRegistry.startRun({
    appSessionId: sessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: 1,
    origin,
  });
}

// 넘기기의 핵심은 알림이 아니라 "폰에서 그냥 답장하면 이 대화로 들어온다"는
// 것이다. 명령이 들어갈 세션을 같이 옮기지 않으면, 나가기 직전에 텔레그램을
// 열어 세션을 다시 골라야 한다.
test('넘기기를 켜면 명령이 들어갈 세션도 이쪽으로 옮긴다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    setSessionHandedOver(userId, SESSION_ID, true);

    const state = readBridgeState(userId);
    assert.equal(state.watchedSessionId, SESSION_ID);
    assert.deepEqual(state.notifiedSessionIds, [SESSION_ID]);
    assert.equal(isSessionHandedToTelegram(SESSION_ID), true);
  });
});

test('넘기면 폰에서 보고 있던 다른 대화를 밀어낸다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    writeBridgeState(userId, { watchedSessionId: OTHER_SESSION_ID });

    setSessionHandedOver(userId, SESSION_ID, true);

    assert.equal(readBridgeState(userId).watchedSessionId, SESSION_ID);
  });
});

// 하나만 끄면 폰은 계속 울린다.
test('끄면 알림과 구독을 함께 끈다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    setSessionHandedOver(userId, SESSION_ID, true);

    setSessionHandedOver(userId, SESSION_ID, false);

    const state = readBridgeState(userId);
    assert.equal(state.watchedSessionId, null);
    assert.deepEqual(state.notifiedSessionIds, []);
    assert.equal(isSessionHandedToTelegram(SESSION_ID), false);
  });
});

// 폰으로 A 를 보면서 웹에서 B 를 끄는 조합. B 를 끈다고 A 에서 쫓겨나면 안 된다.
test('다른 대화를 보고 있으면 그 구독은 건드리지 않는다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    writeBridgeState(userId, { watchedSessionId: OTHER_SESSION_ID });

    setSessionHandedOver(userId, SESSION_ID, false);

    assert.equal(readBridgeState(userId).watchedSessionId, OTHER_SESSION_ID);
  });
});

test('넘겨 둔 대화의 웹 실행은 회신 대상이 된다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    setSessionHandedOver(userId, SESSION_ID, true);
    startRun(SESSION_ID);

    assert.equal(shouldRelayCompletion(SESSION_ID), true);
  });
});

test('넘기지 않은 대화의 웹 실행은 조용히 끝난다', async () => {
  await withIsolatedDatabase(() => {
    startRun(SESSION_ID);

    assert.equal(shouldRelayCompletion(SESSION_ID), false);
  });
});

// 폰 앞에서 답을 기다리는 사람이 있다. 넘기기 설정과 무관하게 돌려보낸다.
test('텔레그램에서 시작한 실행은 넘기지 않았어도 회신한다', async () => {
  await withIsolatedDatabase(() => {
    startRun(SESSION_ID, 'telegram');

    assert.equal(shouldRelayCompletion(SESSION_ID), true);
  });
});
