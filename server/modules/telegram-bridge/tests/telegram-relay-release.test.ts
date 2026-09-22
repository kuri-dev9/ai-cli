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
import { claimRelayHandoff, releaseRelayHandoff } from '@/modules/telegram-bridge/index.js';
import {
  readBridgeState,
  writeBridgeState,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry, parseTelegramReleasePrefix } from '@/modules/websocket/index.js';

/**
 * `/unbot` — `/bot` 의 반대.
 *
 * 넘기는 길이 화면에 있으면 되돌리는 길도 있어야 한다. 이게 없으면 브라우저
 * 앞에 앉은 사람이 폰을 조용히 시키려고 텔레그램을 열어야 한다.
 */

const SESSION_ID = 'release-session';
const OTHER_SESSION_ID = 'release-other-session';

async function withIsolatedDatabase(
  runTest: (context: { userId: number }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-release-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('release', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Release Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Release session');
    sessionsDb.createAppSession(OTHER_SESSION_ID, 'claude', tempDirectory, 'Other session');
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

test('접두어를 떼고, 뗐다는 사실을 알려준다', () => {
  assert.deepEqual(parseTelegramReleasePrefix('/unbot 계속 진행해줘'), {
    content: '계속 진행해줘',
    releaseRequested: true,
  });
});

test('뒤에 아무 말이 없어도 명령으로 본다', () => {
  // `/bot` 과 갈리는 지점이다. 놓는 것은 그 자체로 끝나는 일이라 보낼 말이
  // 없어도 성립한다.
  assert.deepEqual(parseTelegramReleasePrefix('/unbot'), {
    content: '',
    releaseRequested: true,
  });
});

test('대소문자는 가리지 않는다', () => {
  assert.equal(parseTelegramReleasePrefix('/UNBOT').releaseRequested, true);
});

test('비슷하게 생긴 말은 건드리지 않는다', () => {
  assert.deepEqual(parseTelegramReleasePrefix('/unbotanical 정리해줘'), {
    content: '/unbotanical 정리해줘',
    releaseRequested: false,
  });
});

test('넘겨받은 대화를 놓으면 구독과 알림이 함께 꺼진다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
      origin: 'web',
      relayRequested: true,
    });
    assert.equal(claimRelayHandoff(SESSION_ID), true);

    assert.equal(releaseRelayHandoff(SESSION_ID), true);

    const state = readBridgeState(userId);
    // 하나만 꺼지면 폰은 계속 울린다.
    assert.equal(state.watchedSessionId, null);
    assert.equal(state.notifiedSessionIds.includes(SESSION_ID), false);
  });
});

test('보고 있지 않던 대화를 놓으면 아무 일도 없다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    writeBridgeState(userId, { watchedSessionId: OTHER_SESSION_ID });

    // 안 보던 대화를 놓았다는 안내는 무슨 일이 일어났는지만 헷갈리게 한다.
    assert.equal(releaseRelayHandoff(SESSION_ID), false);
    assert.equal(readBridgeState(userId).watchedSessionId, OTHER_SESSION_ID);
  });
});

test('다른 대화를 놓아도 보고 있던 대화는 남는다', async () => {
  await withIsolatedDatabase(({ userId }) => {
    writeBridgeState(userId, {
      watchedSessionId: OTHER_SESSION_ID,
      notifiedSessionIds: [OTHER_SESSION_ID, SESSION_ID],
    });

    assert.equal(releaseRelayHandoff(SESSION_ID), true);

    const state = readBridgeState(userId);
    assert.equal(state.watchedSessionId, OTHER_SESSION_ID);
    assert.deepEqual(state.notifiedSessionIds, [OTHER_SESSION_ID]);
  });
});
