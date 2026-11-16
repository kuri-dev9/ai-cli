import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  roomsDb,
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  handleTelegramCommand,
  isSessionHandedToTelegram,
  truncateForTelegram,
} from '@/modules/telegram-bridge/index.js';
import {
  handleTelegramButton,
  resolveRoomLeaderSessionId,
} from '@/modules/telegram-bridge/services/telegram-commands.service.js';
import {
  readTelegramSettings,
  writeTelegramSettings,
} from '@/modules/telegram-bridge/services/telegram-settings.service.js';
import {
  isSessionNotified,
  readBridgeState,
  setSessionNotified,
} from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';

/** 답이 버튼을 달고 와도 글만 본다. */
function replyText(reply: Awaited<ReturnType<typeof handleTelegramCommand>>): string {
  return typeof reply === 'string' ? reply : reply?.text ?? '';
}

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

    assert.match(replyText(reply), /구독 중인 세션이 없/);
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

test('인자 없는 /watch 는 되묻지 않고 프로젝트 목록을 보여준다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    // 텔레그램의 `/` 메뉴는 명령을 누르는 순간 인자 없이 그대로 보내 버린다.
    // 그래서 인자를 받는 `/watch` 는 사실상 항상 맨몸으로 도착한다.
    const reply = await handleTelegramCommand('/watch', {
      userId,
      runtime: createRuntime([]),
    });

    assert.match(replyText(reply), /1\. /);
    assert.match(replyText(reply), /\/watch <번호>/);
    // 예전에는 `/projects` 를 한 번 더 치게 했다.
    assert.doesNotMatch(replyText(reply), /\/projects 로 번호를 확인/);
  });
});

test('맞는 프로젝트가 없으면 고를 수 있는 것을 다시 보여준다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const reply = await handleTelegramCommand('/watch 없는프로젝트', {
      userId,
      runtime: createRuntime([]),
    });

    assert.match(replyText(reply), /없는프로젝트/);
    assert.match(replyText(reply), /1\. /);
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

test('여기서 보낸 턴이 도는 동안에도 다음 명령을 바로 처리한다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    // 끝나지 않는 턴. 예전에는 명령 처리가 이 턴이 끝날 때까지 돌아오지 않아,
    // 브리지의 폴링 전체가 멈추고 /stop 조차 턴이 끝난 뒤에야 처리됐다.
    let finishTurn: () => void = () => {};
    const aborted: string[] = [];
    const runtime = {
      hasRuntime: () => true,
      run: () => new Promise<void>((resolve) => { finishTurn = resolve; }),
      abort: async (_provider: string, sessionId: string) => {
        aborted.push(sessionId);
        finishTurn();
        return true;
      },
      getPendingApprovalsForSession: () => [],
      resolveToolApproval: () => {},
    } as never;
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand('오래 걸리는 일', { userId, runtime });
    assert.equal(reply, null);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);

    assert.match(replyText(await handleTelegramCommand('/status', { userId, runtime })), /작업 중/);
    assert.match(replyText(await handleTelegramCommand('/stop', { userId, runtime })), /중단했습니다/);
    assert.deepEqual(aborted, [SESSION_ID]);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);
  });
});

test('작업 중에 보낸 글에는 끼어들기·비우기 버튼이 달리고, 누르면 그대로 된다', async () => {
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

    const queued = await handleTelegramCommand('방향 바꿔', { userId, runtime });
    assert.match(replyText(queued), /대기열에 넣었습니다 \(1번째\)/);
    const buttons = typeof queued === 'object' && queued ? queued.buttons.flat().map((button) => button.data) : [];
    assert.deepEqual(buttons, [`steer:${SESSION_ID}`, `qclear:${SESSION_ID}`]);

    const listed = await handleTelegramCommand('/queue', { userId, runtime });
    assert.match(replyText(listed), /1\. 방향 바꿔/);

    // 끼어들기는 지금 턴을 멈춘다. 멈추면 대기열 맨 앞의 글이 이어서 나간다.
    const steer = await handleTelegramButton(`steer:${SESSION_ID}`, { userId, runtime });
    assert.match(replyText(steer.reply), /지금 턴을 멈췄습니다/);
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    // 여기에는 대기열을 비우는 디스패처가 떠 있지 않아 글이 아직 남아 있다.
    // 비우기는 웹 화면과 같은 대기열 칸을 비운다.
    assert.equal(sessionDraftsDb.countQueuedMessages(userId, SESSION_ID), 1);
    const cleared = await handleTelegramButton(`qclear:${SESSION_ID}`, { userId, runtime });
    assert.match(replyText(cleared.reply), /1건을 비웠습니다/);
    assert.equal(sessionDraftsDb.countQueuedMessages(userId, SESSION_ID), 0);
  });
});

test('/on 은 구독한 세션이 있어야 켤 수 있다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([]);

    const reply = await handleTelegramCommand('/on', { userId, runtime });

    // 켤 대상이 없는데 "켰다"고 답하면, 알림이 오지 않는 이유를 영영 알 수 없다.
    assert.match(replyText(reply), /구독 중인 세션이 없/);
  });
});

test('/on 은 구독 중인 세션의 웹 작업 알림을 켠다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([]);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand('/on', { userId, runtime });
    assert.equal(isSessionNotified(userId, SESSION_ID), true);
    const status = await handleTelegramCommand('/status', { userId, runtime });
    assert.match(replyText(status), /웹 작업 알림: 켜짐/);
    assert.match(replyText(status), /여기서 보낸 작업의 결과는 항상 옵니다/);
  });
});

test('/off 는 구독·넘기기·완료 알림·방 알림을 전부 끈다', async () => {
  await withIsolatedDatabase(async ({ userId, projectPath }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    // 다른 대화 하나는 웹에서 넘기기로 켜 두었다.
    sessionsDb.createAppSession('other-session', 'claude', projectPath, 'Other');
    setSessionNotified(userId, 'other-session', true);
    writeTelegramSettings({ notifyOnCompletion: true });
    roomsDb.createRoom(
      { roomId: 'room-1', hostSessionId: SESSION_ID, projectPath, permissionMode: 'ask', maxAutoTurns: 3 },
      [],
    );
    roomsDb.updateRoomSettings('room-1', { notifyTelegram: true });

    await handleTelegramCommand('/watch 1', { userId, runtime });
    await handleTelegramCommand('/on', { userId, runtime });

    const reply = replyText(await handleTelegramCommand('/off', { userId, runtime }));
    assert.match(reply, /전부 껐습니다/);
    assert.match(reply, /완료 알림/);
    assert.match(reply, /방 라운드 알림 1개/);

    // 예전 `/off` 는 구독 중인 대화의 표시 하나만 껐고, 나머지가 계속 울렸다.
    assert.equal(isSessionNotified(userId, SESSION_ID), false);
    assert.equal(isSessionNotified(userId, 'other-session'), false);
    assert.equal(readBridgeState(userId).watchedSessionId, null);
    assert.equal(readTelegramSettings().notifyOnCompletion, false);
    assert.equal(roomsDb.getRoom('room-1')?.notify_telegram, 0);
    // 그 대화가 이제 폰으로 넘어가 있지 않다는 것이 웹 쪽에도 그대로 보인다.
    assert.equal(isSessionHandedToTelegram(SESSION_ID), false);

    // 구독도 놓았으므로 그냥 보낸 글은 실행되지 않는다.
    const afterOff = await handleTelegramCommand('이건 가면 안 된다', { userId, runtime });
    assert.match(replyText(afterOff), /구독 중인 세션이 없습니다/);
    assert.equal(runs.length, 0);

    // 이미 다 꺼져 있으면 그렇다고만 말한다.
    assert.match(replyText(await handleTelegramCommand('/off', { userId, runtime })), /켜져 있는 알림이 없습니다/);
  });
});

test('룸이 가장 최근이면 /watch 는 마지막에 말한 참가자가 아니라 방장을 구독한다', async () => {
  await withIsolatedDatabase(async ({ userId, projectPath }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    const earlier = '2026-11-14T00:00:00.000Z';
    const later = '2026-11-14T01:00:00.000Z';
    // 참가자가 방금 답해서 가장 최근에 손댄 세션이다.
    sessionsDb.createSession('member-session', 'claude', projectPath, 'Member', earlier, later, null);
    const participant = (id: string, sessionId: string, position: number) => ({
      participant_id: id,
      session_id: sessionId,
      provider: 'claude',
      model: null,
      claude_account_id: null,
      display_name: id,
      role_name: '',
      role_prompt: '',
      persona: '',
      status: 'active' as const,
      position,
    });
    roomsDb.createRoom(
      { roomId: 'room-1', hostSessionId: SESSION_ID, projectPath, permissionMode: 'ask', maxAutoTurns: 3 },
      [participant('host', SESSION_ID, 0), participant('member', 'member-session', 1)],
    );

    await handleTelegramCommand('/watch 1', { userId, runtime });
    assert.equal(readBridgeState(userId).watchedSessionId, SESSION_ID);
    await handleTelegramCommand('방장에게', { userId, runtime });
    assert.deepEqual(runs.map((run) => run.command), ['방장에게']);

    // 방장을 다른 참가자에게 넘겼으면 그 참가자다.
    roomsDb.setLeader('room-1', 'member');
    assert.equal(resolveRoomLeaderSessionId(SESSION_ID), 'member-session');
    // 룸이 아닌 대화는 그대로다.
    assert.equal(resolveRoomLeaderSessionId('not-in-room'), 'not-in-room');
  });
});

test('/unwatch 는 구독과 알림을 함께 놓는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });
    await handleTelegramCommand('/on', { userId, runtime });

    const reply = await handleTelegramCommand('/unwatch', { userId, runtime });

    assert.match(replyText(reply), /구독을 놓았습니다/);
    // 웹 작업 알림도 같이 꺼져야 한다. 구독만 놓고 알림이 남으면 `/bot` 으로
    // 넘겨받은 대화가 계속 이쪽으로 온다.
    assert.equal(isSessionNotified(userId, SESSION_ID), false);

    // 구독이 없으므로 그냥 보낸 글은 실행되지 않는다.
    const afterRelease = await handleTelegramCommand('이건 가면 안 된다', { userId, runtime });
    assert.match(replyText(afterRelease), /구독 중인 세션이 없습니다/);
    assert.equal(runs.length, 0);
  });
});

test('/help 는 모든 명령을 보여준다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runtime = createRuntime([]);
    const reply = await handleTelegramCommand('/help', { userId, runtime });

    for (const command of ['/status', '/projects', '/watch', '/unwatch', '/on', '/off', '/allow', '/deny', '/stop']) {
      assert.ok(replyText(reply).includes(command), `${command} 가 /help 에 없다`);
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
    assert.match(replyText(reply), /승인 대기 1건/);
    assert.match(replyText(reply), /Bash/);
  });
});

test('모르는 슬래시 명령은 프롬프트로 흘려보내지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand('/deploy', { userId, runtime });

    assert.match(replyText(reply), /모르는 명령/);
    assert.equal(runs.length, 0);
  });
});

test('긴 메시지는 텔레그램 한도에 맞춰 잘린다', () => {
  const truncated = truncateForTelegram('가'.repeat(5_000));

  assert.ok(truncated.length <= 4_096);
  assert.match(truncated, /잘림/);
});
