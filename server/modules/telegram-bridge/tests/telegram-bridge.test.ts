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
import { handleTelegramCommand, truncateForTelegram } from '@/modules/telegram-bridge/index.js';
import { isSessionNotified } from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

const SESSION_ID = 'telegram-session';

async function withIsolatedDatabase(
  runTest: (context: { userId: number; projectPath: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-bridge-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('bridge', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Bridge Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Bridge session');
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

type RunCall = { command: string };

function createRuntime(runs: RunCall[], pendingApprovals: unknown[] = []) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string) => {
      runs.push({ command });
    },
    abort: async () => true,
    getPendingApprovalsForSession: () => pendingApprovals,
    resolveToolApproval: (requestId: string, decision: { allow: boolean }) => {
      pendingApprovals.push({ resolved: requestId, allow: decision.allow });
    },
  } as never;
}

test('구독 전에는 명령을 세션으로 보내지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const reply = await handleTelegramCommand('테스트 돌려줘', {
      userId,
      runtime: createRuntime(runs),
    });

    assert.match(reply ?? '', /구독 중인 세션이 없/);
    assert.equal(runs.length, 0);
  });
});

test('/watch 로 고른 세션에 명령이 들어간다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    await handleTelegramCommand('/watch 1', { userId, runtime });
    const reply = await handleTelegramCommand('테스트 돌려줘', { userId, runtime });

    // 잘 들어갔다는 확인 한 줄은 보내지 않는다. 결과가 곧 따라온다.
    assert.equal(reply, null);
    assert.deepEqual(runs.map((run) => run.command), ['테스트 돌려줘']);
  });
});

test('작업 중에 보낸 명령은 거절되지 않고 대기열로 간다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    await handleTelegramCommand('첫 번째', { userId, runtime });
    await handleTelegramCommand('두 번째', { userId, runtime });

    // 실행 중이므로 어느 것도 바로 나가지 않는다.
    assert.equal(runs.length, 0);
    // 그리고 둘 다 살아 있다 — 뒤엣것이 앞엣것을 덮어쓰지 않는다.
    assert.equal(sessionDraftsDb.countQueuedMessages(userId, SESSION_ID), 2);
  });
});

test('/on 은 구독한 세션이 있어야 켤 수 있다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([]);

    const reply = await handleTelegramCommand('/on', { userId, runtime });

    // 켤 대상이 없는데 "켰다"고 답하면, 알림이 오지 않는 이유를 영영 알 수 없다.
    assert.match(reply ?? '', /구독 중인 세션이 없/);
  });
});

test('/on 과 /off 는 구독 중인 세션의 웹 작업 알림을 켜고 끈다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([]);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand('/on', { userId, runtime });
    assert.equal(isSessionNotified(userId, SESSION_ID), true);
    assert.match((await handleTelegramCommand('/status', { userId, runtime })) ?? '', /웹 작업 알림: 켜짐/);

    await handleTelegramCommand('/off', { userId, runtime });
    assert.equal(isSessionNotified(userId, SESSION_ID), false);

    // 꺼도 "여기서 보낸 작업의 결과는 온다"는 사실이 화면에 남아 있어야 한다 —
    // 예전 문구는 알림이 통째로 꺼진 것처럼 읽혔다.
    const status = await handleTelegramCommand('/status', { userId, runtime });
    assert.match(status ?? '', /웹 작업 알림: 꺼짐/);
    assert.match(status ?? '', /여기서 보낸 작업의 결과는 항상 옵니다/);
  });
});

test('/off 는 명령 수신까지 막지는 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand('/off', { userId, runtime });
    const reply = await handleTelegramCommand('그래도 실행해줘', { userId, runtime });

    assert.equal(reply, null);
    assert.equal(runs.length, 1);
  });
});

test('/unwatch 는 구독과 알림을 함께 놓는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });
    await handleTelegramCommand('/on', { userId, runtime });

    const reply = await handleTelegramCommand('/unwatch', { userId, runtime });

    assert.match(reply ?? '', /구독을 놓았습니다/);
    // 웹 작업 알림도 같이 꺼져야 한다. 구독만 놓고 알림이 남으면 `/bot` 으로
    // 넘겨받은 대화가 계속 이쪽으로 온다.
    assert.equal(isSessionNotified(userId, SESSION_ID), false);

    // 구독이 없으므로 그냥 보낸 글은 실행되지 않는다.
    const afterRelease = await handleTelegramCommand('이건 가면 안 된다', { userId, runtime });
    assert.match(afterRelease ?? '', /구독 중인 세션이 없습니다/);
    assert.equal(runs.length, 0);
  });
});

test('/help 는 모든 명령을 보여준다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([]);
    const reply = await handleTelegramCommand('/help', { userId, runtime });

    for (const command of ['/status', '/projects', '/watch', '/unwatch', '/on', '/off', '/allow', '/deny', '/stop']) {
      assert.ok(reply?.includes(command), `${command} 가 /help 에 없다`);
    }
  });
});

test('/status 가 승인 대기를 알려준다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([], [{ requestId: 'req-1', toolName: 'Bash' }]);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand('/status', { userId, runtime });

    // 승인 대기를 푸시로 보내지 않기로 했으므로, 여기서 안 보이면 막힌 이유를
    // 알 방법이 아예 없다.
    assert.match(reply ?? '', /승인 대기 1건/);
    assert.match(reply ?? '', /Bash/);
  });
});

test('모르는 슬래시 명령은 프롬프트로 흘려보내지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand('/deploy', { userId, runtime });

    assert.match(reply ?? '', /모르는 명령/);
    assert.equal(runs.length, 0);
  });
});

test('긴 메시지는 텔레그램 한도에 맞춰 잘린다', () => {
  const truncated = truncateForTelegram('가'.repeat(5_000));

  assert.ok(truncated.length <= 4_096);
  assert.match(truncated, /잘림/);
});
