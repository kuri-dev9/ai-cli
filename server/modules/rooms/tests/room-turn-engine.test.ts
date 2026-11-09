import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, roomsDb, scheduledMessagesDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { dispatchDueScheduledMessages } from '@/modules/scheduled-messages/index.js';
import { roomsService } from '@/modules/rooms/services/rooms.service.js';
import { roomTurnEngine } from '@/modules/rooms/services/room-turn-engine.service.js';
import { startTelegramBridge } from '@/modules/telegram-bridge/index.js';
import type { TelegramClient } from '@/modules/telegram-bridge/index.js';
import { activeRunJournal, chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * 룸의 차례가 넘김 표시대로 돌고, 사용자가 끼어들거나 멈출 수 있는가.
 *
 * 런타임은 가짜다. 세션마다 정해 둔 답을 차례로 내고, 받은 프롬프트를 남긴다.
 */

const ROOM_ID = 'room-1';
const HOST = 'host-session';
const REVIEWER = 'reviewer-session';
/** 의견이 엇갈리는 상황을 보려면 의견을 낼 사람이 둘은 있어야 한다. */
const SECOND_REVIEWER = 'second-reviewer-session';

type Call = { sessionId: string; command: string; options: Record<string, unknown> };

type Script = Record<string, Array<string | (() => Promise<string>)>>;

/**
 * `failAfterReply` 에 든 세션은 답을 다 보낸 뒤에 던진다. 프로바이더마다
 * 끝맺는 방식이 달라, 할 말을 다 하고도 종료가 깨끗하지 않은 경우가 있다.
 */
function createRuntime(script: Script, calls: Call[], aborts: string[] = [], failAfterReply: Set<string> = new Set()) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) => {
      const sessionId = String(options.sessionId);
      calls.push({ sessionId, command, options });
      const next = script[sessionId]?.shift() ?? '[PASS]';
      const reply = typeof next === 'function' ? await next() : next;
      writer.send(createNormalizedMessage({ kind: 'text', role: 'assistant', content: reply, sessionId, provider: 'claude' }));
      if (failAfterReply.has(sessionId)) {
        throw new Error('runtime exited with a non-zero status');
      }
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  } as never;
}

/**
 * 테스트 하나를 새 DB 와 두 참가자 룸에서 돌린다. 분담·의견은 기본으로 꺼 둔다 —
 * 켜 두면 차례마다 의견 차례가 끼어 순서를 보는 테스트가 흐려진다. 그 둘을 보는
 * 테스트만 켠다.
 */
async function withRoom(
  maxAutoTurns: number,
  runTest: () => Promise<void>,
  collaboration: { splitWork?: boolean; discussion?: boolean; thirdParticipant?: boolean; hostLed?: boolean } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'room-engine-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(HOST, 'claude', tempDirectory, 'Host', now, now, null);
    sessionsDb.createSession(REVIEWER, 'claude', tempDirectory, 'Reviewer', now, now, null);
    if (collaboration.thirdParticipant) {
      sessionsDb.createSession(SECOND_REVIEWER, 'claude', tempDirectory, 'Reviewer2', now, now, null);
    }
    // 같은 Claude 두 세션이 서로 다른 역할로 들어간다.
    roomsDb.createRoom(
      { roomId: ROOM_ID, hostSessionId: HOST, projectPath: tempDirectory, permissionMode: 'ask', maxAutoTurns },
      [
        { participant_id: 'p-host', session_id: HOST, provider: 'claude', model: null, claude_account_id: null, display_name: 'Claude', role_name: '설계자', role_prompt: '', persona: '', status: 'active', position: 0 },
        { participant_id: 'p-rev', session_id: REVIEWER, provider: 'claude', model: 'sonnet', claude_account_id: null, display_name: 'Claude2', role_name: '리뷰어', role_prompt: '깐깐하게 본다', persona: '', status: 'active', position: 1 },
        ...(collaboration.thirdParticipant
          ? [{ participant_id: 'p-rev2', session_id: SECOND_REVIEWER, provider: 'claude', model: null, claude_account_id: null, display_name: 'Claude3', role_name: '리뷰어2', role_prompt: '', persona: '', status: 'active' as const, position: 2 }]
          : []),
      ],
    );
    roomsDb.updateRoomSettings(ROOM_ID, {
      splitWork: collaboration.splitWork ?? false,
      discussion: collaboration.discussion ?? false,
      hostLed: collaboration.hostLed ?? false,
    });
    await runTest();
  } finally {
    roomTurnEngine.close();
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

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isIdle = () => roomTurnEngine.getState(ROOM_ID, 0).status === 'idle';

function speakers(): string[] {
  return roomsDb.listMessages(ROOM_ID).map((row) => row.speaker);
}

test('the host answers first, hands off by mention, and the room stops on DONE', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['설계안: 세션 토큰 사용\n@Claude2'],
      [REVIEWER]: ['토큰 만료 처리가 빠졌지만 나머지는 좋습니다.\n[DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '로그인 기능 설계해줘' }, 1);
    await waitFor(() => speakers().length === 3 && isIdle(), 'two turns');

    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev']);
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER]);

    // 리뷰어는 처음이라 역할 안내와 함께, 사용자 글과 호스트의 답을 받는다.
    assert.match(calls[1].command, /"@Claude2" 입니다\. 역할: 리뷰어/);
    assert.match(calls[1].command, /깐깐하게 본다/);
    assert.match(calls[1].command, /로그인 기능 설계해줘/);
    assert.match(calls[1].command, /설계안: 세션 토큰 사용/);
    // 참가자별 모델이 턴마다 실린다.
    assert.equal(calls[1].options.model, 'sonnet');
    assert.equal(calls[0].options.model, undefined);

    // 화면이 결론과 넘김 표시를 따로 그릴 수 있게 함께 남는다.
    const [, hostReply, reviewerReply] = roomsService.getRoomDetail(ROOM_ID).messages;
    assert.equal(hostReply.finalText, '설계안: 세션 토큰 사용\n@Claude2');
    assert.deepEqual(hostReply.handoff, { kind: 'mention', participantId: 'p-rev' });
    assert.deepEqual(reviewerReply.handoff, { kind: 'done' });
  });
});

test('later turns send only what the participant has not seen yet', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['첫 답 @Claude2', '두 번째 답 [DONE]'],
      [REVIEWER]: ['리뷰 의견 @Claude'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => speakers().length === 4 && isIdle(), 'three turns');

    const hostSecondPrompt = calls[2].command;
    assert.match(hostSecondPrompt, /리뷰 의견/);
    // 자기 답과 이미 본 사용자 글은 다시 오지 않는다.
    assert.doesNotMatch(hostSecondPrompt, /첫 답/);
    assert.doesNotMatch(hostSecondPrompt, /\n시작/);
    assert.doesNotMatch(hostSecondPrompt, /함께 일하는 참가자/);
  });
});

test('replies without a handoff keep alternating until the auto-turn cap', async () => {
  await withRoom(3, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['의견 1', '의견 3', '의견 5'],
      [REVIEWER]: ['의견 2', '의견 4'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '토론해봐' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'cap');

    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER, HOST]);
  });
});

test('everyone else passing ends the round', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['답했습니다'], [REVIEWER]: ['[PASS]'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '질문' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'pass');
    assert.equal(calls.length, 2);
  });
});

test('a message sent mid-turn to an idle participant is answered right away, alongside the running turn', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const hostReplyGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostReplyGate; return '구현 끝 [DONE]'; }],
      [REVIEWER]: ['테스트부터 보겠습니다 [DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '구현해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');

    const { state } = roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 테스트도 같이 봐줘' }, 1);
    assert.equal(state.status, 'running');
    // 리뷰어는 쉬고 있으니 기다리지 않고 바로 받는다.
    assert.equal(state.pendingUserMessage, false);
    await waitFor(() => calls.length === 2, 'reviewer started alongside');
    assert.match(calls[1].command, /테스트도 같이 봐줘/);
    release();

    await waitFor(() => isIdle() && speakers().length === 4, 'both finished');
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER]);
  });
});

test('곁가지로 글을 받은 방장이 다른 참가자를 부르면 그 참가자가 실제로 답한다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const reviewerGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [REVIEWER]: [async () => { await reviewerGate; return '구현 끝'; }],
      [HOST]: ['구현은 @Claude3 이 맡아 주세요', '정리했습니다 [DONE]'],
      [SECOND_REVIEWER]: ['맡은 일 했습니다'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 구현해줘' }, 1);
    await waitFor(() => calls.length === 1, 'reviewer turn started');

    // 리뷰어가 일하는 동안 방장이 곁가지로 글을 받는다.
    roomsService.postUserMessage(ROOM_ID, { content: '하나 더 부탁해' }, 1);
    // 방장이 넘긴 참가자가 기다리지 않고 들어와 답하고, 답은 방장에게 돌아간다.
    await waitFor(() => calls.filter((call) => call.sessionId === HOST).length === 2, 'host got the result back');
    assert.deepEqual(calls.map((call) => call.sessionId), [REVIEWER, HOST, SECOND_REVIEWER, HOST]);
    release();

    await waitFor(isIdle, 'round done');
  }, { hostLed: true, thirdParticipant: true });
});

test('둘이 동시에 방장을 부르면 방장은 한 번만 답하고, 빈 차례를 돌지 않는다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const hostGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostGate; return '[PASS]'; }, '둘 다 받았습니다 [PASS]', '또 불렸습니다 [PASS]'],
      [REVIEWER]: ['확인했습니다\n@Claude'],
      [SECOND_REVIEWER]: ['저도 확인했습니다\n@Claude'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');

    // 방장이 일하는 동안 두 참가자가 곁가지로 답하고, 둘 다 방장 앞에 줄을 선다.
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 봐줘' }, 1);
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude3 봐줘' }, 1);
    await waitFor(() => speakers().filter((speaker) => speaker === 'p-rev' || speaker === 'p-rev2').length === 2, 'both replied');
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    await waitFor(isIdle, 'round done');
    const hostCalls = calls.filter((call) => call.sessionId === HOST);
    assert.equal(hostCalls.length, 2);
    assert.match(hostCalls[1].command, /저도 확인했습니다/);
    assert.equal(calls.some((call) => call.command.includes('새 메시지 없음')), false);
  }, { hostLed: true, thirdParticipant: true });
});

test('둘을 부른 글은 쉬는 참가자가 먼저 받고, 일하는 참가자는 차례가 끝나면 받는다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const hostGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostGate; return '[PASS]'; }, '봤습니다 [PASS]'],
      [REVIEWER]: ['먼저 봤습니다'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');

    const { state } = roomsService.postUserMessage(ROOM_ID, { content: '@Claude @Claude2 둘 다 봐줘' }, 1);
    // 이미 받기 시작한 글이다. 대기 카드로 남으면 나간 글이 안 나간 것처럼 보인다.
    assert.equal(state.pendingUserMessage, false);
    await waitFor(() => calls.length === 2, 'idle participant started first');
    assert.equal(calls[1].sessionId, REVIEWER);

    release();
    await waitFor(() => isIdle() && calls.length === 3, 'host answered after its turn');
    assert.equal(calls[2].sessionId, HOST);
    assert.match(calls[2].command, /둘 다 봐줘/);
  });
});

test('받을 참가자가 곁가지 차례를 끝내면 메인 차례가 끝나기 전에 글을 받는다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let releaseHost: () => void = () => {};
    let releaseReviewer: () => void = () => {};
    const hostGate = new Promise<void>((resolve) => { releaseHost = resolve; });
    const reviewerGate = new Promise<void>((resolve) => { releaseReviewer = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostGate; return '[PASS]'; }],
      [REVIEWER]: [async () => { await reviewerGate; return '첫 일 끝'; }, '다음 일도 끝'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 첫 일' }, 1);
    await waitFor(() => calls.length === 2, 'reviewer side turn');

    const { state } = roomsService.postUserMessage(ROOM_ID, { content: '⏰ 예약: @Claude2 다음 일' }, 1);
    assert.equal(state.pendingUserMessage, true);

    releaseReviewer();
    await waitFor(() => calls.length === 3, 'reviewer took the waiting message');
    assert.match(calls[2].command, /다음 일/);
    assert.equal(roomTurnEngine.getState(ROOM_ID, 0).pendingUserMessage, false);

    releaseHost();
    await waitFor(isIdle, 'round done');
  });
});

test('정지하면 차례를 기다리던 참가자는 시작하지 않는다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const hostGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostGate; return '[PASS]'; }],
      [REVIEWER]: ['먼저 봤습니다'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude @Claude2 둘 다 봐줘' }, 1);
    await waitFor(() => calls.length === 2, 'reviewer started');

    await roomTurnEngine.stop(roomsDb.getRoom(ROOM_ID)!);
    release();
    await waitFor(isIdle, 'round stopped');
    assert.equal(calls.filter((call) => call.sessionId === HOST).length, 1);
  });
});

test('곁가지 차례가 일하는 중인 참가자를 부르면 그 차례가 끝난 뒤에 답한다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const reviewerGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [REVIEWER]: [async () => { await reviewerGate; return '구현 끝'; }, '이어서 봤습니다'],
      [HOST]: ['@Claude2 끝나면 이것도 봐 주세요', '정리했습니다 [DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 구현해줘' }, 1);
    await waitFor(() => calls.length === 1, 'reviewer turn started');
    roomsService.postUserMessage(ROOM_ID, { content: '진행 어때?' }, 1);
    await waitFor(() => calls.length === 2, 'host side turn');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 한 세션에서 두 실행을 돌리지 않는다.
    assert.equal(calls.length, 2);

    release();
    await waitFor(() => isIdle() && calls.length === 4, 'reviewer answered after its turn');
    assert.deepEqual(calls.map((call) => call.sessionId), [REVIEWER, HOST, REVIEWER, HOST]);
  }, { hostLed: true });
});

test('방장이 부른 뒤 사용자 글이 끼어들어도 부른 참가자는 시작한다', async () => {
  await withRoom(10, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const hostGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostGate; return '조사는 @Claude2 가 맡아 주세요'; }, '받았습니다 [DONE]', '정리했습니다 [DONE]'],
      [REVIEWER]: ['조사했습니다'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '조사 시작' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    // 방장이 일하는 중에 글이 와 줄을 선다.
    roomsService.postUserMessage(ROOM_ID, { content: '그리고 이것도' }, 1);
    release();

    await waitFor(() => isIdle() && calls.some((call) => call.sessionId === REVIEWER), 'reviewer ran');
    assert.ok(calls.some((call) => call.sessionId === REVIEWER), '부른 참가자가 시작해야 한다');
  }, { hostLed: true });
});

test('빈 답으로 끝난 차례는 한 번 다시 묻는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['', '한 일: 조사. [DONE]'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '조사해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'host replied');

    assert.equal(calls.length, 2);
    assert.match(calls[1].command, /빈 답으로 끝났습니다/);
    assert.match(roomsDb.listMessages(ROOM_ID)[1].text, /한 일: 조사/);
  });
});

test('백그라운드 작업을 걸고 빈 답으로 끝난 차례는 다시 묻지 않고 기다린다고 남긴다', async () => {
  await withRoom(1, async () => {
    const calls: Call[] = [];
    const runtime = {
      hasRuntime: () => true,
      run: async (_provider: string, command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) => {
        const sessionId = String(options.sessionId);
        calls.push({ sessionId, command, options });
        writer.send(createNormalizedMessage({ kind: 'tool_use', toolName: 'Monitor', toolInput: { command: 'tail -f out.log' }, sessionId, provider: 'claude' }));
      },
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    } as never;
    roomTurnEngine.initialize(runtime);

    roomsService.postUserMessage(ROOM_ID, { content: '오래 걸리는 질의' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'host replied');

    assert.equal(calls.length, 1);
    assert.match(roomsDb.listMessages(ROOM_ID)[1].text, /백그라운드 작업을 기다리는 중/);
  });
});

test('대기로 돌아간 멤버의 말도 다른 참가자의 프롬프트에 이름이 붙는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    sessionsDb.createSession(SECOND_REVIEWER, 'claude', '/tmp', 'Ester', new Date().toISOString(), new Date().toISOString(), null);
    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: SECOND_REVIEWER, provider: 'claude', model: null, claude_account_id: null,
      display_name: '에스터', role_name: '테스터', role_prompt: '', persona: '', status: 'standby', position: 2,
    });
    roomsDb.insertMessage({ roomId: ROOM_ID, speaker: 'p-roster', text: '테스트 결과 보고', status: 'complete', sessionId: SECOND_REVIEWER, finalText: null, handoff: null, turnKind: 'reply', task: null });
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['봤습니다 [DONE]'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '결과 봐줘' }, 1);
    await waitFor(() => isIdle() && calls.length === 1, 'host replied');
    assert.match(calls[0].command, /\[에스터\(테스터\)\]\n테스트 결과 보고/);
    assert.doesNotMatch(calls[0].command, /알 수 없는 참가자/);
  });
});

test('긴 보고는 잘린 만큼을 알리고 원문 파일 경로를 붙인다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const long = `${'가'.repeat(17000)}끝부분 확인 목록`;
    roomTurnEngine.initialize(createRuntime({ [HOST]: [`${long}\n@Claude2`], [REVIEWER]: ['봤습니다 [DONE]'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '보고해줘' }, 1);
    await waitFor(() => isIdle() && calls.length === 2, 'reviewer replied');
    const match = /원문 파일에서 읽으세요: (\S+\.md)/.exec(calls[1].command);
    assert.ok(match, '원문 경로가 있어야 한다');
    assert.match(calls[1].command, /자 중 앞 16000자만 옮겼습니다/);
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(match[1], 'utf8'), /끝부분 확인 목록/);
  });
});

test('룸 상세는 최근 메시지만 싣고, 그 앞은 따로 불러온다', async () => {
  await withRoom(6, async () => {
    for (let index = 0; index < 70; index += 1) {
      roomsDb.insertMessage({ roomId: ROOM_ID, speaker: 'user', text: `글 ${index}`, status: 'complete', sessionId: null, attachments: null });
    }
    const detail = roomsService.getRoomDetail(ROOM_ID);
    assert.equal(detail.messages.length, 60);
    assert.equal(detail.messages.at(-1)?.text, '글 69');
    assert.equal(detail.hasOlderMessages, true);

    const older = roomsService.listOlderMessages(ROOM_ID, detail.messages[0].id, 60);
    assert.deepEqual(older.messages.map((message) => message.text), Array.from({ length: 10 }, (_, index) => `글 ${index}`));
    assert.equal(older.hasOlderMessages, false);
  });
});

test('기다리는 사용자 글을 취소하면 아무도 받지 않고 라운드는 이어 간다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await gate; return '구현 끝 @Claude2'; }],
      [REVIEWER]: ['봤습니다 [DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '구현해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');

    // 호스트가 일하는 중이라 줄을 선다.
    const first = roomsService.postUserMessage(ROOM_ID, { content: '먼저 보낸 글' }, 1);
    const second = roomsService.postUserMessage(ROOM_ID, { content: '취소할 글' }, 1);
    assert.equal(second.state.pendingMessageId, second.message.id);

    // 마지막 글을 취소해도 앞의 글은 계속 기다린다.
    const afterSecond = roomsService.cancelPendingMessage(ROOM_ID, second.message.id);
    assert.equal(afterSecond.pendingUserMessage, true);
    assert.equal(afterSecond.pendingMessageId, first.message.id);

    const afterFirst = roomsService.cancelPendingMessage(ROOM_ID, first.message.id);
    assert.equal(afterFirst.pendingUserMessage, false);
    assert.equal(afterFirst.pendingMessageId, null);
    assert.throws(
      () => roomsService.cancelPendingMessage(ROOM_ID, first.message.id),
      (error: Error & { code?: string }) => error.code === 'MESSAGE_NOT_PENDING',
    );

    release();
    await waitFor(() => isIdle() && calls.length === 2, 'round went on');
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER]);
    assert.doesNotMatch(calls[1].command, /먼저 보낸 글|취소할 글/);
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev']);
  });
});

test('라운드가 이미 받아 간 사용자 글은 취소할 수 없다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({ [HOST]: [async () => { await gate; return '끝 [DONE]'; }] }, calls));

    const { message } = roomsService.postUserMessage(ROOM_ID, { content: '구현해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    assert.throws(
      () => roomsService.cancelPendingMessage(ROOM_ID, message.id),
      (error: Error & { code?: string }) => error.code === 'MESSAGE_NOT_PENDING',
    );
    release();
    await waitFor(isIdle, 'round done');
  });
});

test('stop aborts the active participant and records the turn as aborted', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const aborts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await gate; return '늦은 답 @Claude2'; }],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '오래 걸리는 일' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');

    const stopping = roomsService.stop(ROOM_ID);
    release();
    await stopping;
    await waitFor(isIdle, 'stopped');

    assert.deepEqual(aborts, [HOST]);
    const last = roomsDb.listMessages(ROOM_ID).at(-1);
    assert.equal(last?.speaker, 'p-host');
    assert.equal(last?.status, 'aborted');
    // 정지 뒤에는 넘김 표시가 있어도 다음 참가자가 돌지 않는다.
    assert.equal(calls.length, 1);
  });
});

test('the roster is capped and names stay unique', async () => {
  await withRoom(6, async () => {
    await assert.rejects(
      roomsService.addParticipant(ROOM_ID, { provider: 'claude', displayName: 'claude2', roleName: '테스터' }),
      (error: Error & { code?: string }) => error.code === 'DISPLAY_NAME_TAKEN' || error.code === 'PROVIDER_UNAVAILABLE',
    );
    await assert.rejects(
      roomsService.addParticipant(ROOM_ID, { provider: 'claude', displayName: 'two words', roleName: '테스터' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_DISPLAY_NAME' || error.code === 'PROVIDER_UNAVAILABLE',
    );
    await assert.rejects(
      roomsService.createRoom({ hostSessionId: REVIEWER, participant: { provider: 'claude', displayName: 'X', roleName: 'y' } }),
      (error: Error & { code?: string }) => error.code === 'ALREADY_A_ROOM',
    );

    // 명단은 상한까지 채울 수 있다. 불리기 전까지 세션도 토큰도 쓰지 않아서다.
    for (let index = 3; index <= 10; index += 1) {
      roomsDb.addParticipant({
        participant_id: `p-${index}`, room_id: ROOM_ID, session_id: null, provider: 'claude', model: null, claude_account_id: null,
        display_name: `멤버${index}`, role_name: '테스터', role_prompt: '', persona: '', status: 'standby', position: index,
      });
    }
    await assert.rejects(
      roomsService.addParticipant(ROOM_ID, { provider: 'claude', displayName: '하나더', roleName: '열한째' }),
      (error: Error & { code?: string }) => error.code === 'ROOM_FULL',
    );
  });
});

/** 브로드캐스트된 프레임을 모으는 가짜 화면. 끝나면 cleanup 으로 뗀다. */
function watchFrames(): { frames: Array<Record<string, unknown>>; cleanup: () => void } {
  const frames: Array<Record<string, unknown>> = [];
  const client = {
    readyState: 1,
    send: (payload: string) => frames.push(JSON.parse(payload) as Record<string, unknown>),
  } as never;
  connectedClients.add(client);
  return { frames, cleanup: () => connectedClients.delete(client) };
}

test('summoning a member tells the open screens, so the chip stops saying standby', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['체커가 봐줘 @체커'] }, calls));
    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null, claude_account_id: null,
      display_name: '체커', role_name: '리뷰어', role_prompt: '', persona: '', status: 'standby', position: 2,
    });

    const watcher = watchFrames();
    try {
      roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
      await waitFor(() => isIdle() && speakers().includes('p-roster'), 'summoned turn');

      // 들어올 때와 대기로 돌아갈 때 모두 알려야 칩이 따라 바뀐다. 이 알림이
      // 없으면 화면은 일하는 중에도 "대기" 를 그대로 띄운다.
      const updates = watcher.frames.filter((frame) => frame.kind === 'room_updated');
      assert.ok(updates.length >= 2, `room_updated 가 두 번 이상 와야 한다 (${updates.length})`);
      assert.ok(updates.every((frame) => frame.roomId === ROOM_ID));
    } finally {
      watcher.cleanup();
    }
  });
});

test('a roster member is summoned by name, answers, and returns to standby', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['체커가 봐줘 @체커'] }, calls));

    // 명단에만 담긴 멤버. 세션이 아직 없다.
    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null, claude_account_id: null,
      display_name: '체커', role_name: '리뷰어', role_prompt: '버그만 짚는다', persona: '', status: 'standby', position: 2,
    });
    const before = roomsService.getRoomDetail(ROOM_ID).participants.find((p) => p.displayName === '체커');
    assert.equal(before?.sessionId, null);
    assert.equal(before?.status, 'standby');

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().includes('p-roster'), 'summoned turn');

    // 불리면서 세션이 생기고, 그 세션에서 실제로 돌았다.
    const after = roomsService.getRoomDetail(ROOM_ID).participants.find((p) => p.displayName === '체커');
    assert.ok(after?.sessionId, '불릴 때 세션이 생겨야 한다');
    assert.ok(calls.some((call) => call.sessionId === after?.sessionId), '생긴 세션에서 차례가 돌아야 한다');
    // 답을 마치면 다시 대기로 돌아간다.
    assert.equal(after?.status, 'standby');

    // 호스트의 첫 차례 프롬프트에 부를 수 있는 멤버로 적혀 있었다.
    assert.match(calls[0].command, /부를 수 있는 멤버/);
    assert.match(calls[0].command, /@체커: 리뷰어/);
  });
});

test('a roster member keeps the model and effort picked while it waited, once it is summoned', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['체커가 봐줘 @체커'] }, calls));
    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: 'sonnet', claude_account_id: null,
      display_name: '체커', role_name: '리뷰어', role_prompt: '', persona: '', status: 'standby', position: 2,
    });

    // 세션이 없어도 고를 수 있어야 한다. 명단에 적혀 있다가 처음 불릴 때 옮겨진다.
    const updated = roomsService.updateParticipant(ROOM_ID, 'p-roster', { model: 'opus', effort: 'high' });
    const waiting = updated.participants.find((p) => p.participantId === 'p-roster');
    assert.equal(waiting?.sessionId, null);
    assert.equal(waiting?.model, 'opus');
    assert.equal(waiting?.effort, 'high');

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().includes('p-roster'), 'summoned turn');

    const after = roomsService.getRoomDetail(ROOM_ID).participants.find((p) => p.participantId === 'p-roster');
    assert.ok(after?.sessionId, '불릴 때 세션이 생겨야 한다');
    const session = sessionsDb.getSessionById(after.sessionId);
    assert.equal(session?.model, 'opus');
    assert.equal(session?.effort, 'high');
  });
});

test('a standby member sits out the rounds it is not called into', async () => {
  await withRoom(4, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['혼자 끝냈습니다 [DONE]'] }, calls));

    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null, claude_account_id: null,
      display_name: '테스티', role_name: '테스터', role_prompt: '', persona: '', status: 'standby', position: 2,
    });

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'host only');

    // 부르지 않았으니 세션도 생기지 않고 차례도 돌지 않았다.
    const roster = roomsService.getRoomDetail(ROOM_ID).participants.find((p) => p.displayName === '테스티');
    assert.equal(roster?.sessionId, null);
    assert.equal(calls.length, 1);
  });
});

test('changing the room permission clears the per-participant overrides', async () => {
  await withRoom(6, async () => {
    roomTurnEngine.initialize(createRuntime({}, []));

    // 한 명만 따로 전체 허용으로 둔 상태.
    roomsService.updateParticipant(ROOM_ID, 'p-rev', { permissionMode: 'full' });
    assert.deepEqual(
      roomsService.getRoomDetail(ROOM_ID).participants.map((participant) => participant.permissionMode),
      ['ask', 'full'],
    );

    // 룸 권한을 바꾸면 따로 둔 값도 지워져 전원이 같은 권한을 쓴다.
    const detail = roomsService.updateSettings(ROOM_ID, { permissionMode: 'read' });
    assert.equal(detail.room.permissionMode, 'read');
    assert.deepEqual(detail.participants.map((participant) => participant.permissionMode), ['read', 'read']);
  });
});

test('each participant runs with its own permission, model and effort', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['답 @Claude2'], [REVIEWER]: ['[DONE]'] }, calls));

    roomsService.updateParticipant(ROOM_ID, 'p-rev', { permissionMode: 'full' });
    // 참가자 설정에서 바꾼 모델은 세션에 적힌다. 초대할 때의 값보다 이것이 이긴다.
    sessionsDb.setSessionModel(REVIEWER, 'opus');
    sessionsDb.setSessionEffort(REVIEWER, 'high');

    const detail = roomsService.getRoomDetail(ROOM_ID);
    assert.deepEqual(detail.participants.map((participant) => participant.permissionMode), ['ask', 'full']);

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'two turns');

    assert.equal(calls[0].options.permissionMode, undefined);
    assert.equal(calls[1].options.permissionMode, 'bypassPermissions');
    assert.equal(calls[1].options.model, 'opus');
    assert.equal(calls[1].options.effort, 'high');
  });
});

test('a role changed mid-room reaches the participant on its next turn', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['첫 답 @Claude2', '둘째 답 @Claude2'],
      [REVIEWER]: ['[DONE]', '[DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'first round');
    // 첫 차례에는 초대할 때의 역할이 간다.
    assert.match(calls[1].command, /역할 설명: 깐깐하게 본다/);

    roomsService.updateParticipant(ROOM_ID, 'p-rev', {
      roleName: '보안 검토자',
      rolePrompt: '보안 문제만 본다',
      persona: '단호하다',
    });
    assert.deepEqual(
      roomsService.getRoomDetail(ROOM_ID).participants.map((participant) => participant.roleName),
      ['설계자', '보안 검토자'],
    );

    roomsService.postUserMessage(ROOM_ID, { content: '다음' }, 1);
    await waitFor(() => isIdle() && speakers().length === 6, 'second round');

    // 두 번째 차례는 첫 차례가 아닌데도 역할 안내를 통째로 다시 받는다.
    const reviewerSecond = calls.filter((call) => call.sessionId === REVIEWER)[1];
    assert.match(reviewerSecond.command, /\[바뀜\]/);
    assert.match(reviewerSecond.command, /역할: 보안 검토자/);
    assert.match(reviewerSecond.command, /역할 설명: 보안 문제만 본다/);
    assert.match(reviewerSecond.command, /성향: 단호하다/);
    // 고치지 않은 호스트는 짧은 알림만 받는다.
    assert.doesNotMatch(calls.filter((call) => call.sessionId === HOST)[1].command, /\[바뀜\]/);
  });
});

test('renaming a participant re-briefs everyone else, so mentions keep working', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['첫 답 @Claude2', '둘째 답 @체커'],
      [REVIEWER]: ['[DONE]', '[DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'first round');

    roomsService.updateParticipant(ROOM_ID, 'p-rev', { displayName: '체커' });

    roomsService.postUserMessage(ROOM_ID, { content: '다음' }, 1);
    await waitFor(() => isIdle() && speakers().length === 6, 'second round');

    // 이름이 바뀌면 다른 참가자도 새 이름이 적힌 참가자 목록을 다시 받는다.
    const hostSecond = calls.filter((call) => call.sessionId === HOST)[1];
    assert.match(hostSecond.command, /@체커: 리뷰어/);
    // 호스트가 새 이름으로 부른 멘션이 그대로 닿는다.
    assert.equal(speakers().at(-1), 'p-rev');
  });
});

test('attachments are kept on the user message and handed to each participant once', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['봤어요 @Claude2', '[DONE]'], [REVIEWER]: ['저도요 @Claude'] }, calls));

    roomsService.postUserMessage(ROOM_ID, {
      content: '이 화면 봐줘',
      // 업로드 저장소 밖의 파일은 버린다.
      attachments: [{ path: 'shot.png', name: 'shot.png', mimeType: 'image/png' }, { path: '/etc/passwd' }],
    }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'three turns');

    const stored = roomsService.getRoomDetail(ROOM_ID).messages[0];
    assert.deepEqual(stored.attachments.map((attachment) => attachment.name), ['shot.png']);
    assert.equal((calls[0].options.attachments as unknown[]).length, 1);
    assert.equal((calls[1].options.attachments as unknown[]).length, 1);
    // 이미 본 글의 첨부는 다음 차례에 다시 오지 않는다.
    assert.equal(((calls[2].options.attachments as unknown[]) ?? []).length, 0);
  });
});

test('interrupting aborts the current speaker and moves straight to the waiting message', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const aborts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await gate; return '길게 쓰던 답 @Claude'; }, '바로 볼게요 [DONE]'],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '오래 걸리는 일' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    // 이름이 없으니 방장(호스트)이 받을 글이다. 호스트가 일하는 중이라 기다린다.
    roomsService.postUserMessage(ROOM_ID, { content: '잠깐, 이것부터' }, 1);

    const interrupting = roomsService.interrupt(ROOM_ID);
    release();
    await interrupting;
    await waitFor(() => isIdle() && speakers().length === 4, 'interrupted round');

    assert.deepEqual(aborts, [HOST]);
    const rows = roomsDb.listMessages(ROOM_ID);
    assert.deepEqual(rows.map((row) => row.speaker), ['user', 'user', 'p-host', 'p-host']);
    // 끊긴 답은 실패가 아니라 중단이고, 루프는 멈추지 않고 기다리던 글로 넘어간다.
    assert.equal(rows[2].status, 'aborted');
    assert.equal(rows[3].status, 'complete');
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, HOST]);
  });
});

test('일하는 참가자가 있어도 사용자가 부른 쉬는 참가자는 끊지 않고 바로 받는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const aborts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await gate; return '길게 끝냈습니다 [DONE]'; }],
      [REVIEWER]: ['테스트 받았습니다 [DONE]'],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '오래 걸리는 일' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 test. 대답만 해줘' }, 1);

    // 호스트가 아직 일하는 중인데 리뷰어가 먼저 답한다. 아무도 끊기지 않는다.
    await waitFor(() => speakers().includes('p-rev'), 'reviewer answered alongside');
    assert.deepEqual(aborts, []);
    assert.equal(roomTurnEngine.getState(ROOM_ID, 0).status, 'running');
    assert.match(calls[1].command, /대답만 해줘/);

    release();
    await waitFor(() => isIdle() && speakers().length === 4, 'host finished');
    const rows = roomsDb.listMessages(ROOM_ID);
    assert.deepEqual(rows.map((row) => [row.speaker, row.status]), [
      ['user', 'complete'], ['user', 'complete'], ['p-rev', 'complete'], ['p-host', 'complete'],
    ]);
  });
});

test('받을 참가자가 지금 일하는 바로 그 참가자면 끊지 않고 그 차례 뒤에 받는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const aborts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await gate; return '첫 일 끝 [DONE]'; }, '다음 것도 했습니다 [DONE]'],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '일 시작' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    // 이름이 없으니 방장(호스트)이 받는데, 호스트는 지금 일하는 중이다.
    roomsService.postUserMessage(ROOM_ID, { content: '이것도 이어서 해줘' }, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(aborts, []);
    assert.equal(roomTurnEngine.getState(ROOM_ID, 0).pendingUserMessage, true);

    release();
    await waitFor(() => isIdle() && speakers().length === 4, 'host took it after');
    assert.deepEqual(roomsDb.listMessages(ROOM_ID).map((row) => [row.speaker, row.status]), [
      ['user', 'complete'], ['user', 'complete'], ['p-host', 'complete'], ['p-host', 'complete'],
    ]);
    assert.match(calls[1].command, /이것도 이어서 해줘/);
  });
});

test('끼어들기는 끊어도 끝나지 않는 실행이라도 놓고 기다리던 글로 넘어간다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const aborts: string[] = [];
    roomTurnEngine.initialize(createRuntime({
      // 끊겨도 끝나지 않는 실행. 예전에는 이 차례에 루프가 무한정 묶였다.
      [HOST]: [() => new Promise<string>(() => {}), '이어서 받았습니다 [DONE]'],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '오래 걸리는 일' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    roomsService.postUserMessage(ROOM_ID, { content: '그만하고 이것부터' }, 1);
    await roomsService.interrupt(ROOM_ID);
    await waitFor(() => isIdle() && speakers().length === 4, 'moved on');

    assert.deepEqual(aborts, [HOST]);
    assert.deepEqual(roomsDb.listMessages(ROOM_ID).map((row) => [row.speaker, row.status]), [
      ['user', 'complete'], ['user', 'complete'], ['p-host', 'aborted'], ['p-host', 'complete'],
    ]);
  });
});

test('a host command runs as written in the host session and does not start a round', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['압축했습니다'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '/compact', hostCommand: true }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'host command');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, HOST);
    assert.equal(calls[0].command, '/compact');
    assert.deepEqual(speakers(), ['user', 'p-host']);
  });
});

test('compacting sends the command to each session and keeps the timeline', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['요약했습니다'], [REVIEWER]: ['요약했습니다'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle(), 'first round');
    const before = speakers().length;
    calls.length = 0;

    await roomsService.compact(ROOM_ID);

    // 세션마다 명령이 그대로 간다. 룸 안내문으로 감싸면 명령으로 읽히지 않는다.
    assert.deepEqual(calls.map((call) => call.command), ['/compact', '/compact']);
    assert.deepEqual(new Set(calls.map((call) => call.sessionId)), new Set([HOST, REVIEWER]));
    // 줄인 답은 룸 타임라인에 올리지 않는다. 그 세션의 살림이지 오간 말이 아니다.
    assert.equal(speakers().length, before);
  });
});

test('compacting mid-round shrinks only the idle participants and delays their next turn until done', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let releaseHost: () => void = () => {};
    const hostGate = new Promise<void>((resolve) => { releaseHost = resolve; });
    let releaseCompact: () => void = () => {};
    const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['먼저 봐 두세요 @Claude2', async () => { await hostGate; return '구현 끝 [DONE]'; }],
      [REVIEWER]: ['봤습니다 @Claude', async () => { await compactGate; return '요약했습니다'; }, '테스트도 보겠습니다 [DONE]'],
    }, calls));

    // 리뷰어 세션을 한 번 만들어 둔 뒤 호스트만 일하게 한다.
    roomsService.postUserMessage(ROOM_ID, { content: '구현해줘' }, 1);
    await waitFor(() => calls.length === 3, 'host working again');

    const state = await roomsService.compact(ROOM_ID);
    // 일하는 호스트는 그대로, 쉬던 리뷰어만 줄인다. 라운드도 그대로 돈다.
    assert.equal(state.status, 'running');
    assert.deepEqual(state.activeParticipantIds, ['p-host']);
    assert.deepEqual(state.compactingParticipantIds, ['p-rev']);
    await waitFor(() => calls.length === 4, 'reviewer compacting');
    assert.deepEqual([calls[3].sessionId, calls[3].command], [REVIEWER, '/compact']);

    // 줄이는 중인 리뷰어를 부르면 압축이 끝난 뒤에 받는다.
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 테스트도 봐줘' }, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 4);
    releaseCompact();
    await waitFor(() => calls.length === 5, 'reviewer turn after compaction');
    assert.equal(calls[4].sessionId, REVIEWER);
    assert.match(calls[4].command, /테스트도 봐줘/);

    releaseHost();
    await waitFor(() => isIdle(), 'round done');
    assert.deepEqual(roomTurnEngine.getState(ROOM_ID, 6).compactingParticipantIds, []);
  });
});

test('a turn ends at its complete even while the provider holds the process for background work', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let releaseProcess: () => void = () => {};
    const processGate = new Promise<void>((resolve) => { releaseProcess = resolve; });
    roomTurnEngine.initialize({
      hasRuntime: () => true,
      run: async (_provider: string, command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) => {
        const sessionId = String(options.sessionId);
        calls.push({ sessionId, command, options });
        writer.send(createNormalizedMessage({ kind: 'text', role: 'assistant', content: '구현 끝, 시험은 뒤에서 돕니다 [DONE]', sessionId, provider: 'claude' }));
        writer.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, sessionId, provider: 'claude' }));
        // 백그라운드 작업이 보고하러 오기를 기다리며 프로세스가 남아 있다.
        await processGate;
      },
      abort: async () => true,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    } as never);

    roomsService.postUserMessage(ROOM_ID, { content: '구현해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'turn ended at complete');
    assert.deepEqual(speakers(), ['user', 'p-host']);
    assert.equal(roomsDb.listMessages(ROOM_ID)[1].status, 'complete');
    releaseProcess();
  });
});

test('room state revisions only grow, so a late reply cannot roll back a newer frame', () => {
  const first = roomTurnEngine.getState(ROOM_ID, 6).revision;
  const second = roomTurnEngine.getState(ROOM_ID, 6).revision;
  assert.ok(second > first);
});

test('compacting one participant leaves the others alone', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [REVIEWER]: ['요약했습니다'] }, calls));

    await roomsService.compact(ROOM_ID, 'p-rev');

    assert.deepEqual(calls.map((call) => call.sessionId), [REVIEWER]);
  });
});

test('a read-only turn asks nothing when the participant is set to full access', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [
        '이렇게 나눕니다.\n[작업 @Claude2 수정] 테스트 작성\n[작업 @Claude] 기존 코드 조사',
        async () => { await gate; return '조사했습니다'; },
        '정리했습니다 [DONE]',
      ],
      [REVIEWER]: [async () => { await gate; return '테스트를 추가했습니다'; }],
    }, calls));

    // 룸 전체를 전체 허용으로. 사용자가 "묻지 말라" 고 정한 상태다.
    roomsService.updateSettings(ROOM_ID, { permissionMode: 'full' });
    roomsService.postUserMessage(ROOM_ID, { content: '손봐줘' }, 1);
    await waitFor(() => calls.length === 3, 'both assignees started');
    release();
    await waitFor(() => isIdle(), 'round done');

    const readOnlyTurn = calls[1].sessionId === HOST ? calls[1] : calls[2];
    const tools = readOnlyTurn.options.toolsSettings as { allowedTools: string[]; disallowedTools: string[] };
    // 조사에 필요한 셸은 묻지 않고 바로 쓴다. 이게 없어서 라운드가 승인 창에서 멈췄다.
    assert.ok(tools.allowedTools.includes('Bash'), 'Bash 가 허용 목록에 있어야 한다');
    // 역할 지시에 적은 스킬도 묻지 않고 부른다.
    assert.ok(tools.allowedTools.includes('Skill'), 'Skill 이 허용 목록에 있어야 한다');
    // 그래도 파일은 고치지 못한다. 동시에 같은 폴더를 고치면 서로 덮어쓴다.
    assert.deepEqual(tools.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  }, { splitWork: true });
});

test('a read-only turn still asks when the participant is set to ask', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [
        '이렇게 나눕니다.\n[작업 @Claude2 수정] 테스트 작성\n[작업 @Claude] 기존 코드 조사',
        async () => { await gate; return '조사했습니다'; },
        '정리했습니다 [DONE]',
      ],
      [REVIEWER]: [async () => { await gate; return '테스트를 추가했습니다'; }],
    }, calls));

    // 기본값은 매번 묻기. 사용자가 그걸 고른 것이므로 셸도 승인을 받는다.
    roomsService.postUserMessage(ROOM_ID, { content: '손봐줘' }, 1);
    await waitFor(() => calls.length === 3, 'both assignees started');
    release();
    await waitFor(() => isIdle(), 'round done');

    const readOnlyTurn = calls[1].sessionId === HOST ? calls[1] : calls[2];
    const tools = readOnlyTurn.options.toolsSettings as { allowedTools: string[] };
    assert.ok(!tools.allowedTools.includes('Bash'), '매번 묻기에서는 셸도 승인을 받는다');
    // 스킬은 지시문을 읽어 올 뿐이라 매번 묻기에서도 묻지 않는다.
    assert.ok(tools.allowedTools.includes('Skill'), '매번 묻기에서도 Skill 은 허용 목록에 있어야 한다');
  }, { splitWork: true });
});

test('a worked participant leaves the room and its session goes to the archive', async () => {
  await withRoom(6, async () => {
    assert.throws(
      () => roomsService.removeParticipant(ROOM_ID, 'p-host'),
      (error: Error & { code?: string }) => error.code === 'HOST_CANNOT_LEAVE',
    );

    const detail = roomsService.removeParticipant(ROOM_ID, 'p-rev');
    // 명단에서 빠지고, 지난 발언에 이름을 붙이도록 퇴장한 참가자로만 남는다.
    assert.deepEqual(detail.participants.map((participant) => participant.participantId), ['p-host']);
    assert.deepEqual(detail.formerParticipants.map((participant) => participant.participantId), ['p-rev']);
    // 사이드바의 룸 밑에서도 빠진다.
    assert.equal(roomsDb.getParticipantBySession(REVIEWER), null);
    assert.deepEqual(
      roomsService.listRoomIndex()[0].participants.map((participant) => participant.participantId),
      ['p-host'],
    );
    // 세션은 보관함으로 가서 프로젝트 목록에 평범한 세션으로 튀어나오지 않는다.
    assert.equal(sessionsDb.getSessionById(REVIEWER)?.isArchived, 1);
    // 빠진 참가자는 불러도 오지 않는다.
    assert.throws(() => roomsService.removeParticipant(ROOM_ID, 'p-rev'));
  });
});

test('a roster member that was never called is dropped outright, freeing its name', async () => {
  await withRoom(6, async () => {
    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null, claude_account_id: null,
      display_name: '체커', role_name: '리뷰어', role_prompt: '', persona: '', status: 'standby', position: 2,
    });

    const detail = roomsService.removeParticipant(ROOM_ID, 'p-roster');
    assert.deepEqual(detail.participants.map((participant) => participant.participantId), ['p-host', 'p-rev']);
    // 행이 사라졌으므로 같은 이름을 다시 쓸 수 있다.
    assert.deepEqual(detail.formerParticipants, []);
    roomsDb.addParticipant({
      participant_id: 'p-again', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null, claude_account_id: null,
      display_name: '체커', role_name: '리뷰어', role_prompt: '', persona: '', status: 'standby', position: 3,
    });
    assert.ok(roomsService.getRoomDetail(ROOM_ID).participants.some((p) => p.displayName === '체커'));
  });
});

function kinds(): Array<string | null> {
  return roomsDb.listMessages(ROOM_ID).map((row) => row.turn_kind);
}

test('a plan splits the work, the assignees work at the same time, and the lead sums up', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [
        '이렇게 나눕니다.\n[작업 @Claude2 수정] 로그인 테스트 작성\n[작업 @Claude] 기존 인증 코드 조사',
        async () => { await gate; return '인증은 세션 토큰을 씁니다'; },
        '정리: 테스트와 조사 결과를 합쳤습니다\n[DONE]',
      ],
      [REVIEWER]: [async () => { await gate; return '테스트 3개를 추가했습니다'; }],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '로그인 기능 손봐줘' }, 1);
    // 두 사람이 동시에 일한다: 어느 쪽도 끝나기 전에 둘 다 시작했다.
    await waitFor(() => calls.length === 3, 'both assignees started');
    const working = roomTurnEngine.getState(ROOM_ID, 6);
    assert.equal(working.phase, 'working');
    assert.deepEqual([...working.activeParticipantIds].sort(), ['p-host', 'p-rev']);
    release();
    await waitFor(() => isIdle() && speakers().length === 5, 'summary');

    // 첫 차례는 나눌 수 있다는 안내를 받는다.
    assert.match(calls[0].command, /\[분담\]/);
    const reviewerTask = calls.find((call) => call.sessionId === REVIEWER)!;
    const hostTask = calls[1].sessionId === HOST ? calls[1] : calls[2];
    assert.match(reviewerTask.command, /수정 담당/);
    assert.match(hostTask.command, /파일 수정: 불가/);
    // 수정 담당이 아닌 쪽은 쓰기 도구가 막힌다.
    assert.deepEqual((hostTask.options.toolsSettings as { disallowedTools: string[] }).disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    assert.equal(reviewerTask.options.toolsSettings, undefined);
    // 리더가 결과를 받아 정리한다.
    assert.match(calls[3].command, /\[정리\]/);
    assert.match(calls[3].command, /테스트 3개를 추가했습니다/);

    assert.deepEqual(kinds(), [null, 'plan', 'task', 'task', 'summary']);
    const tasks = roomsService.getRoomDetail(ROOM_ID).messages.filter((message) => message.turnKind === 'task');
    assert.deepEqual(
      tasks.map((message) => message.task).sort((a, b) => Number(b?.canEdit) - Number(a?.canEdit)),
      [{ text: '로그인 테스트 작성', canEdit: true }, { text: '기존 인증 코드 조사', canEdit: false }],
    );
  }, { splitWork: true });
});

test('with discussion on, the others weigh in on each reply and a bare [PASS] leaves no trace', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['설계안입니다', '[PASS]'],
      [REVIEWER]: ['좋아요. 다만 토큰 만료를 같이 봐야 해요', '만료 처리를 넣었습니다 [DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '설계해줘' }, 1);
    await waitFor(() => isIdle() && calls.length === 4, 'discussion');

    assert.match(calls[1].command, /\[의견\] 방금 @Claude 의 답/);
    // 의견 차례는 읽기 전용이다.
    assert.ok(calls[1].options.toolsSettings);
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev', 'p-rev']);
    assert.deepEqual(kinds(), [null, 'reply', 'comment', 'reply']);
  }, { discussion: true });
});

test('interrupting stops everyone working in parallel', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const aborts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['[작업 @Claude2] 조사\n[작업 @Claude] 정리', async () => { await gate; return '정리 중'; }, '알겠습니다 [DONE]'],
      [REVIEWER]: [async () => { await gate; return '조사 중'; }],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => calls.length === 3, 'parallel started');
    roomsService.postUserMessage(ROOM_ID, { content: '잠깐, 방향 바꿀게' }, 1);

    const interrupting = roomsService.interrupt(ROOM_ID);
    release();
    await interrupting;
    await waitFor(() => isIdle() && calls.length === 4, 'redirected');

    assert.deepEqual([...aborts].sort(), [HOST, REVIEWER]);
    const tasks = roomsDb.listMessages(ROOM_ID).filter((row) => row.turn_kind === 'task');
    assert.deepEqual(tasks.map((row) => row.status), ['aborted', 'aborted']);
    // 끊긴 뒤에는 정리가 아니라 사용자의 새 글로 넘어간다.
    assert.match(calls[3].command, /방향 바꿀게/);
    assert.doesNotMatch(calls[3].command, /\[정리\]/);
  }, { splitWork: true });
});

/**
 * 의견 차례에 적힌 넘김 표시.
 *
 * 예전에는 그 값을 아무도 읽지 않으면서 타임라인에는 "○○ 에게 넘김" 이라고
 * 그려 두었다. 화면은 다음 차례를 약속하는데 방은 그대로 멈춰 서서, 밖에서는
 * 넘기려다 실패한 것처럼 보였다.
 */
test('의견이 한 사람을 가리키면, 화자가 끝내려 했어도 그 참가자가 이어받는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      // 호스트는 이야기를 맺으려 한다.
      [HOST]: ['정리했습니다 [DONE]', '그 점은 이렇습니다 [DONE]'],
      // 그런데 의견 차례에서 반대가 나오고, 호스트를 지목한다.
      // 되받은 답에는 보탤 말이 없다 — 맨 [PASS] 는 타임라인에 남지 않는다.
      [REVIEWER]: ['그 결론은 이릅니다 @Claude', '[PASS]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '설계 검토해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length >= 4, 'the comment handoff is followed');

    // 호스트가 한 번 더 답한다 — [DONE] 만 읽던 때는 p-rev 에서 멈췄다.
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev', 'p-host']);
  }, { discussion: true });
});

test('되받은 차례의 의견은 따르지 않는다 — 둘이 서로 부르며 돌지 않게', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['정리했습니다 [DONE]', '다시 정리했습니다 [DONE]', '또 [DONE]'],
      // 의견 차례마다 호스트를 부른다. 그대로 따르면 턴 상한까지 돈다.
      [REVIEWER]: ['아직입니다 @Claude', '그래도 아닙니다 @Claude', '여전합니다 @Claude'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '설계 검토해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length >= 4, 'the room settles');

    // 한 번만 되받고 끝난다. 되받은 차례의 의견까지 따랐다면 더 길어졌을 것이다.
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev', 'p-host', 'p-rev']);
  }, { discussion: true });
});

test('의견이 서로 다른 사람을 가리키면 아무 쪽도 따르지 않는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['정리했습니다 [DONE]'],
      // 둘이 서로 다른 사람을 부른다. 방 전체의 뜻이 아니라 각자의 의견이다.
      [REVIEWER]: ['저는 Claude3 가 봐야 한다고 봅니다 @Claude3'],
      [SECOND_REVIEWER]: ['저는 Claude2 가 이어야 한다고 봅니다 @Claude2'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '설계 검토해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length >= 4, 'the room settles');

    // 의견 둘은 남지만 차례는 넘어가지 않고, 호스트의 [DONE] 대로 끝난다.
    assert.deepEqual(speakers().slice(0, 2), ['user', 'p-host']);
    assert.equal(speakers().filter((speaker) => speaker === 'p-host').length, 1, '호스트가 되받으면 안 된다');
  }, { discussion: true, thirdParticipant: true });
});

/**
 * 화면의 "턴 n/N".
 *
 * 세는 시점이 차례를 끝낸 뒤였다. 그래서 첫 차례가 도는 내내 0 으로 남았고,
 * 지금 몇 번째인지 읽으려는 사람에게는 줄곧 한 칸씩 모자란 숫자였다. 도는
 * 횟수 자체는 그때도 맞았다 — 상한 3 이면 세 번 돈다.
 */
test('턴 번호는 차례가 도는 동안 그 차례를 가리킨다', async () => {
  await withRoom(5, async () => {
    const seen: number[] = [];
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [
        async () => {
          seen.push(roomTurnEngine.getState(ROOM_ID, 5).turnCount);
          return '첫 답 @Claude2';
        },
        async () => {
          seen.push(roomTurnEngine.getState(ROOM_ID, 5).turnCount);
          return '셋째 답 [DONE]';
        },
      ],
      [REVIEWER]: [
        async () => {
          seen.push(roomTurnEngine.getState(ROOM_ID, 5).turnCount);
          return '둘째 답 @Claude';
        },
      ],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '토론해봐' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'three turns');

    // 끝내고 세던 때는 [0, 1, 2] 였다.
    assert.deepEqual(seen, [1, 2, 3]);
    // 다 돌고 난 뒤의 값은 그대로 "돈 횟수" 다.
    assert.equal(roomTurnEngine.getState(ROOM_ID, 5).turnCount, 3);
  });
});

test('세는 시점을 옮겨도 상한만큼만 돈다', async () => {
  await withRoom(3, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['의견 1', '의견 3', '의견 5'],
      [REVIEWER]: ['의견 2', '의견 4'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '토론해봐' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'cap');

    assert.equal(calls.length, 3, '상한 3 이면 세 번이다');
    assert.equal(roomTurnEngine.getState(ROOM_ID, 3).turnCount, 3);
  });
});

/**
 * 답은 다 받았는데 런타임이 끝에 가서 탈이 난 차례.
 *
 * 그런 차례를 실패로 적으면 룸은 거기서 멈춘다 — 화면에는 멀쩡한 답이 보이는데
 * 다음 차례가 오지 않는, 밖에서는 까닭을 알 수 없는 모습이 된다. 프로바이더를
 * 섞어 쓸 때 한쪽에서만 그런 꼬리가 붙기도 한다.
 */
test('답을 받은 차례는 런타임이 끝에 탈이 나도 이어 간다', async () => {
  await withRoom(5, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['첫 답 @Claude2', '셋째 답 [DONE]'],
      [REVIEWER]: ['둘째 답 @Claude'],
    }, calls, [], new Set([REVIEWER])));

    roomsService.postUserMessage(ROOM_ID, { content: '토론해봐' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'the room keeps going');

    // 고치기 전에는 ['user', 'p-host', 'p-rev'] 에서 멈췄다.
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev', 'p-host']);

    const messages = roomsService.getRoomDetail(ROOM_ID).messages;
    assert.equal(messages[2].status, 'complete', '받아 낸 답이 있으면 완료다');
    assert.match(messages[2].text, /둘째 답/);
  });
});

test('받아 낸 말이 없으면 여전히 실패로 적고 거기서 멈춘다', async () => {
  await withRoom(5, async () => {
    const calls: Call[] = [];
    // 빈 답만 내고 던진다 — 할 말을 못 받은 차례다.
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['첫 답 @Claude2'],
      [REVIEWER]: [''],
    }, calls, [], new Set([REVIEWER])));

    roomsService.postUserMessage(ROOM_ID, { content: '토론해봐' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'the room stops');

    const messages = roomsService.getRoomDetail(ROOM_ID).messages;
    assert.equal(messages[2].status, 'error');
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev']);
  });
});

test('방장 주도에서는 방장이 부르지 않으면 다른 참가자가 답하지 않는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    // 넘김 표시 없이 끝난 답. 보통의 룸이라면 순서대로 리뷰어에게 넘어간다.
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['혼자 답했습니다'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '질문' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'host only');

    assert.deepEqual(calls.map((call) => call.sessionId), [HOST]);
    assert.match(calls[0].command, /\[방장 주도\] 당신이 이 룸의 방장입니다/);
  }, { hostLed: true, discussion: true, thirdParticipant: true });
});

test('방장 주도에서 방장이 부른 참가자의 답은 방장에게 돌아오고, 의견 차례는 없다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['리뷰 부탁합니다\n@Claude2', '정리했습니다'],
      // 리뷰어가 다른 참가자를 불러도 따르지 않는다.
      [REVIEWER]: ['괜찮습니다\n@Claude3'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '설계해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'host, reviewer, host');

    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER, HOST]);
    assert.match(calls[1].command, /방장 @Claude 가 부를 때만 답합니다/);
  }, { hostLed: true, discussion: true, thirdParticipant: true });
});

test('방장을 넘기면 새 방장이 사용자 글을 먼저 받고 다른 참가자를 부른다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [REVIEWER]: ['설계해 주세요\n@Claude', '정리했습니다'],
      [HOST]: ['설계했습니다'],
    }, calls));

    const detail = roomsService.setLeader(ROOM_ID, 'p-rev');
    assert.deepEqual(detail.participants.filter((member) => member.isHost).map((member) => member.participantId), ['p-rev']);
    // 원래 대화는 방장이 아니어도 원래 대화다.
    assert.equal(detail.participants.find((member) => member.participantId === 'p-host')?.isOrigin, true);

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'leader, host, leader');

    assert.deepEqual(calls.map((call) => call.sessionId), [REVIEWER, HOST, REVIEWER]);
    assert.match(calls[0].command, /\[방장 주도\] 당신이 이 룸의 방장입니다/);
    assert.match(calls[1].command, /방장 @Claude2 가 부를 때만 답합니다/);

    // 원래 대화로 돌려주면 따로 적어 둔 방장이 지워진다.
    roomsService.setLeader(ROOM_ID, 'p-host');
    assert.equal(roomsDb.getRoom(ROOM_ID)?.leader_participant_id, null);
  }, { hostLed: true, thirdParticipant: true });
});

test('새 대화로 여는 룸은 방장 혼자로 시작하고, 방장의 모델·계정이 그 세션에 적힌다', async () => {
  await withRoom(6, async () => {
    const projectPath = roomsDb.getRoom(ROOM_ID)!.project_path;
    // 앱이 막 연 세션. 프로바이더가 아직 세션 id 를 알려 온 적이 없다.
    sessionsDb.createAppSession('fresh-host', 'claude', projectPath, '새 룸');

    const detail = await roomsService.createRoom({
      hostSessionId: 'fresh-host',
      host: { displayName: '케이', roleName: '정리자', rolePrompt: '정리한다', model: 'opus', claudeAccountId: 'acct-2' },
    });

    assert.equal(detail.participants.length, 1);
    const [host] = detail.participants;
    assert.equal(host.displayName, '케이');
    assert.equal(host.isHost, true);
    assert.equal(host.isOrigin, true);
    assert.equal(host.model, 'opus');
    assert.equal(sessionsDb.getSessionById('fresh-host')?.model, 'opus');
    assert.equal(sessionsDb.getSessionById('fresh-host')?.claude_account_id, 'acct-2');
  });
});

test('이미 대화가 있는 세션으로 여는 룸은 그 대화의 모델을 바꾸지 않는다', async () => {
  await withRoom(6, async () => {
    const projectPath = roomsDb.getRoom(ROOM_ID)!.project_path;
    const now = new Date().toISOString();
    // 디스크에 기록이 있는 세션은 프로바이더 세션 id 를 이미 안다.
    const sessionId = sessionsDb.createSession('old-host', 'claude', projectPath, 'Old', now, now, null);

    const detail = await roomsService.createRoom({
      hostSessionId: sessionId,
      host: { displayName: '케이', roleName: '정리자', model: 'opus' },
    });

    assert.equal(detail.participants[0].model, null);
    assert.equal(sessionsDb.getSessionById(sessionId)?.model ?? null, null);
  });
});

test('참가자가 남긴 예약 줄은 예약 메시지가 되고, 때가 되면 룸 메시지로 올라와 그 참가자 차례를 연다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['장애가 끝나면 보겠습니다.\n[예약 +20분] 장애 끝났는지 보고 분석 시작\n[DONE]', '분석했습니다\n[DONE]'],
    }, calls));
    const userId = Number(userDb.createUser('room-owner', 'hash').id);

    roomsService.postUserMessage(ROOM_ID, { content: '장애 끝나면 분석해줘' }, userId);
    await waitFor(() => isIdle() && speakers().length === 2, 'host scheduled');

    const pending = scheduledMessagesDb.listForSession(userId, HOST).filter((row) => row.status === 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].content, '@Claude 장애 끝났는지 보고 분석 시작');
    const dueIn = new Date(pending[0].scheduled_for).getTime() - Date.now();
    assert.ok(dueIn > 19 * 60 * 1000 && dueIn <= 20 * 60 * 1000);

    // 때가 됐다. 세션 하나에 보내지 않고 룸에 올려, 이름을 부른 참가자가 받는다.
    await dispatchDueScheduledMessages({} as never, new Date(Date.now() + 21 * 60 * 1000));
    await waitFor(() => isIdle() && speakers().length === 4, 'scheduled turn');

    const messages = roomsService.getRoomDetail(ROOM_ID).messages;
    assert.equal(messages[2].speaker, 'user');
    assert.match(messages[2].text, /^⏰ 예약: @Claude 장애 끝났는지 보고 분석 시작/);
    assert.equal(messages[3].speaker, 'p-host');
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, HOST]);
  });
});

test('참가자는 걸린 예약을 프롬프트에서 보고, 번호로 지우며, 같은 예약을 다시 적어도 한 번만 걸린다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    const userId = Number(userDb.createUser('room-owner', 'hash').id);
    const keep = scheduledMessagesDb.create({ userId, sessionId: HOST, content: '@Claude 남길 것', options: {}, scheduledFor: new Date(Date.now() + 30 * 60_000) });
    const drop = scheduledMessagesDb.create({ userId, sessionId: HOST, content: '@Claude 지울 것', options: {}, scheduledFor: new Date(Date.now() + 40 * 60_000) });
    const dropId = drop.id.replace(/-/g, '').slice(0, 6);
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [`정리합니다.\n[예약취소 #${dropId}]\n[예약 +20분] 새로 건 것\n[예약 +20분] 새로 건 것\n[DONE]`],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '예약 정리해줘' }, userId);
    await waitFor(() => isIdle() && speakers().length === 2, 'host cleaned up');

    // 걸린 예약이 번호와 함께 보였다.
    assert.match(calls[0].command, new RegExp(`#${dropId} \\d{2}:\\d{2} @Claude 지울 것`));
    assert.match(calls[0].command, /\[걸린 예약 2개\]/);

    const pending = scheduledMessagesDb.listPendingForSession(HOST).map((row) => row.content);
    assert.deepEqual(pending, ['@Claude 새로 건 것', '@Claude 남길 것']);
    assert.ok(scheduledMessagesDb.listPendingForSession(HOST).some((row) => row.id === keep.id));
  });
});

test('룸에서 뺀 방장은 방장 자리를 원래 대화에 돌려준다', async () => {
  await withRoom(6, async () => {
    roomTurnEngine.initialize(createRuntime({}, []));
    roomsService.setLeader(ROOM_ID, 'p-rev');
    const detail = roomsService.removeParticipant(ROOM_ID, 'p-rev');
    assert.equal(detail.participants.find((member) => member.isHost)?.participantId, 'p-host');
  });
});

test('방장 주도에서 사용자가 직접 부른 참가자는 답하고 끝난다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [REVIEWER]: ['봤습니다'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 이거 봐줘' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'reviewer only');

    assert.deepEqual(calls.map((call) => call.sessionId), [REVIEWER]);
  }, { hostLed: true });
});

test('참가자는 차례마다 몇 번째 턴인지와 남은 턴을 듣고, 마지막 턴에는 마무리하라는 말을 듣는다', async () => {
  await withRoom(2, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['첫 답 @Claude2'], [REVIEWER]: ['둘째 답 @Claude'] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'two turns');

    assert.match(calls[0].command, /\[턴 1\/2\] 이번 라운드에 남은 자동 턴: 1/);
    assert.doesNotMatch(calls[0].command, /마지막 턴입니다/);
    assert.match(calls[1].command, /\[턴 2\/2\] 이번 라운드에 남은 자동 턴: 0/);
    assert.match(calls[1].command, /마지막 턴입니다/);
  });
});

test('도는 중에 늘린 턴 상한을 다음 차례부터 따르고, 참가자도 바뀐 숫자를 듣는다', async () => {
  await withRoom(2, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => {
        roomsService.updateSettings(ROOM_ID, { maxAutoTurns: 3 });
        return '첫 답 @Claude2';
      }, '셋째 답'],
      [REVIEWER]: ['둘째 답 @Claude'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 4, 'three turns');

    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER, HOST]);
    assert.match(calls[1].command, /\[턴 2\/3\]/);
  });
});

test('맥락이 많이 찬 세션은 그 차례 전에 스스로 줄인다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(
      // 가짜 런타임은 `/compact` 에도 대본 한 줄을 쓴다.
      createRuntime({ [HOST]: ['답 @Claude2', '[DONE]'], [REVIEWER]: ['줄였습니다', '리뷰\n[DONE]'] }, calls),
      { readTokenUsage: async (sessionId) => (sessionId === REVIEWER ? { used: 150_000, total: 200_000 } : { used: 10_000, total: 200_000 }) },
    );

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'two turns');

    assert.deepEqual(
      calls.map((call) => [call.sessionId, call.command === '/compact' ? 'compact' : 'turn']),
      [[HOST, 'turn'], [REVIEWER, 'compact'], [REVIEWER, 'turn']],
    );
    // 압축 결과는 타임라인에 남지 않는다.
    assert.deepEqual(speakers(), ['user', 'p-host', 'p-rev']);
    assert.equal(roomsDb.listMessages(ROOM_ID).at(-1)?.text, '리뷰\n[DONE]');
  });
});

test('자동 압축을 끄면 맥락이 차도 줄이지 않는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(
      createRuntime({ [HOST]: ['[DONE]'] }, calls),
      { readTokenUsage: async () => ({ used: 190_000, total: 200_000 }) },
    );
    roomsService.updateSettings(ROOM_ID, { autoCompact: false });

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 2, 'one turn');

    assert.deepEqual(calls.map((call) => call.command === '/compact'), [false]);
  });
});

test('새 룸은 방장 주도와 자동 압축이 켜진 채로 만들어진다', async () => {
  await withRoom(6, async () => {
    const otherRoom = 'room-defaults';
    const now = new Date().toISOString();
    sessionsDb.createSession('defaults-host', 'claude', '/tmp', 'Host', now, now, null);
    roomsDb.createRoom(
      { roomId: otherRoom, hostSessionId: 'defaults-host', projectPath: '/tmp', permissionMode: 'ask', maxAutoTurns: 6 },
      [{ participant_id: 'p-defaults', session_id: 'defaults-host', provider: 'claude', model: null, claude_account_id: null, display_name: 'Claude', role_name: '설계자', role_prompt: '', persona: '', status: 'active', position: 0 }],
    );
    const { room } = roomsService.getRoomDetail(otherRoom);
    assert.equal(room.hostLed, true);
    assert.equal(room.autoCompact, true);
  });
});

test('맥락이 60% 를 넘으면 줄이고, 그 아래면 두지 않는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(
      createRuntime({ [HOST]: ['답 @Claude2'], [REVIEWER]: ['줄였습니다', '리뷰\n[DONE]'] }, calls),
      { readTokenUsage: async (sessionId) => (sessionId === REVIEWER ? { used: 122_000, total: 200_000 } : { used: 118_000, total: 200_000 }) },
    );

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'two turns');

    assert.deepEqual(
      calls.map((call) => [call.sessionId, call.command === '/compact' ? 'compact' : 'turn']),
      [[HOST, 'turn'], [REVIEWER, 'compact'], [REVIEWER, 'turn']],
    );
  });
});

test('이름만 여럿 적은 마지막 줄은 모두를 동시에 부르고, 답이 모이면 부른 참가자가 정리한다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['둘에게 묻습니다\n@Claude2 @Claude3', '모아서 정리했습니다 [DONE]'],
      [REVIEWER]: [async () => { await gate; return '리뷰어 답'; }],
      [SECOND_REVIEWER]: [async () => { await gate; return '두 번째 리뷰어 답'; }],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '검토해줘' }, 1);
    // 둘 다 시작했는데 아직 아무도 끝나지 않았다 — 순서대로가 아니라 동시에 돈다.
    await waitFor(() => calls.length === 3, 'both called');
    release();
    await waitFor(() => isIdle(), 'round done');

    assert.deepEqual(calls.slice(1, 3).map((call) => call.sessionId).sort(), [REVIEWER, SECOND_REVIEWER].sort());
    assert.equal(calls[3].sessionId, HOST);
    assert.match(calls[3].command, /\[정리\]/);
    for (const called of calls.slice(1, 3)) {
      assert.match(called.command, /\[동시 호출\] @Claude 가/);
      // 동시에 도는 동안은 아무도 파일을 고치지 못한다.
      const tools = called.options.toolsSettings as { disallowedTools: string[] };
      assert.deepEqual(tools.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    }
    const hostReply = roomsService.getRoomDetail(ROOM_ID).messages[1];
    assert.deepEqual(hostReply.handoff, { kind: 'group', participantIds: ['p-rev', 'p-rev2'] });
  }, { thirdParticipant: true });
});

test('사용자가 이름을 여럿 적으면 그 참가자들이 동시에 답하고 라운드가 끝난다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [REVIEWER]: ['리뷰어입니다\n@Claude'],
      [SECOND_REVIEWER]: ['두 번째 리뷰어입니다'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 @Claude3 자기소개 해줘' }, 1);
    await waitFor(() => isIdle() && speakers().length === 3, 'both answered');

    // 호스트는 부르지 않았고, 답 끝의 넘김도 따르지 않는다. 다음은 사용자가 정한다.
    assert.deepEqual(calls.map((call) => call.sessionId).sort(), [REVIEWER, SECOND_REVIEWER].sort());
    assert.match(calls[0].command, /\[동시 호출\] 사용자 가/);
  }, { thirdParticipant: true });
});

test('방장 주도에서 방장이 여럿을 함께 부르면 모두 답한 뒤 방장에게 돌아온다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['인사해 주세요\n@Claude2, @Claude3', '모두 인사했습니다'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '다들 불러줘' }, 1);
    await waitFor(() => isIdle() && speakers().length === 5, 'host, two members, host');

    assert.equal(calls[0].sessionId, HOST);
    assert.deepEqual(calls.slice(1, 3).map((call) => call.sessionId).sort(), [REVIEWER, SECOND_REVIEWER].sort());
    assert.equal(calls[3].sessionId, HOST);
  }, { hostLed: true, discussion: true, thirdParticipant: true });
});

test('라운드가 도는 동안 상태가 DB 에 적히고, 끝나면 지워진다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({ [HOST]: [async () => { await gate; return '끝났습니다 [DONE]'; }] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => calls.length === 1, 'host started');
    const during = JSON.parse(roomsDb.getRoom(ROOM_ID)?.loop_state ?? 'null');
    assert.deepEqual(during.active, [{ participantId: 'p-host', readOnly: false }]);
    assert.equal(during.turnCount, 1);

    release();
    await waitFor(() => isIdle(), 'round done');
    assert.equal(roomsDb.getRoom(ROOM_ID)?.loop_state, null);
  });
});

test('서버가 내려가는 중에 끝난 라운드는 상태를 남겨 둔다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    roomTurnEngine.initialize(createRuntime({ [HOST]: [async () => { await gate; return '끊겼습니다'; }] }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => calls.length === 1, 'host started');
    activeRunJournal.markStopping();
    try {
      release();
      await waitFor(() => isIdle(), 'round done');
      // 끊길 때 일하던 사람까지 그대로 남아야 다시 떠서 이어 줄 수 있다.
      const kept = JSON.parse(roomsDb.getRoom(ROOM_ID)?.loop_state ?? 'null');
      assert.deepEqual(kept.active, [{ participantId: 'p-host', readOnly: false }]);
    } finally {
      activeRunJournal.reset();
    }
  });
});

test('다시 뜬 뒤 끊긴 참가자가 같은 권한으로 마무리하고, 방장이 이어서 진행한다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [REVIEWER]: ['조사를 마쳤습니다'],
      [HOST]: ['이어서 정리했습니다 [DONE]'],
    }, calls));
    roomsDb.setLoopState(ROOM_ID, JSON.stringify({
      userId: 1,
      turnCount: 2,
      active: [{ participantId: 'p-rev', readOnly: true }, { participantId: 'p-host', readOnly: false }],
      resumeCount: 0,
    }));

    assert.equal(roomTurnEngine.resumeAfterRestart(ROOM_ID, { maxResumes: 2 }), 'resumed');
    await waitFor(() => isIdle() && calls.length === 2, 'resumed round done');

    // 방장은 마무리 차례를 따로 받지 않는다. 이어서 진행하는 차례가 곧 방장의 몫이다.
    assert.deepEqual(calls.map((call) => call.sessionId), [REVIEWER, HOST]);
    assert.match(calls[0].command, /\[이어서\]/);
    const tools = calls[0].options.toolsSettings as { disallowedTools: string[] };
    assert.deepEqual(tools.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    assert.match(calls[1].command, /\[재시작\]/);
    // 끊기기 전의 턴 수에서 이어 센다.
    assert.match(calls[1].command, /\[턴 4\/6\]/);
    assert.equal(roomsDb.getRoom(ROOM_ID)?.loop_state, null);
  });
});

test('이미 두 번 이어 간 라운드는 더 이어 가지 않는다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({}, calls));
    roomsDb.setLoopState(ROOM_ID, JSON.stringify({ userId: 1, turnCount: 3, active: [], resumeCount: 2 }));

    assert.equal(roomTurnEngine.resumeAfterRestart(ROOM_ID, { maxResumes: 2 }), 'skipped');
    assert.equal(calls.length, 0);
    assert.equal(roomsDb.getRoom(ROOM_ID)?.loop_state, null);
  });
});

/** 폴링도 네트워크도 없는 가짜 텔레그램 클라이언트. 보낸 메시지만 모은다. */
function createFakeTelegramClient(sent: string[]): TelegramClient {
  return {
    getUpdates: (_offset: number, signal?: AbortSignal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
    getMe: async () => ({ username: 'test_bot' }),
    sendMessage: async (_chatId: number, text: string) => {
      sent.push(text);
    },
    requestTimeoutMs: 1_000,
  } as unknown as TelegramClient;
}

test('방의 텔레그램 알림을 켜면 참가자 두 명의 턴이 끝나도 라운드가 끝날 때 한 번만 간다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['설계안: 세션 토큰 사용\n@Claude2'],
      [REVIEWER]: ['확인했습니다.\n[DONE]'],
    }, calls));

    roomsDb.updateRoomSettings(ROOM_ID, { notifyTelegram: true });
    const sent: string[] = [];
    const bridge = startTelegramBridge({
      botToken: 'test-token',
      allowedChatIds: [4242],
      runtime: {
        hasRuntime: () => true,
        run: async () => {},
        abort: async () => true,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      } as never,
      client: createFakeTelegramClient(sent),
    });

    try {
      roomsService.postUserMessage(ROOM_ID, { content: '로그인 기능 설계해줘' }, 1);
      // 두 참가자가 다 답하고 라운드가 멈출 때까지 기다린다.
      await waitFor(() => speakers().length === 3 && isIdle(), 'two turns');
      // 라운드 알림은 setImmediate 로 미뤄진다.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const roundNotifications = sent.filter((message) => message.includes('🏁'));
      assert.equal(roundNotifications.length, 1, '참가자 두 명의 턴이 아니라 라운드 전체에 한 번이어야 한다');
    } finally {
      bridge.stop();
    }
  });
});

test('방의 텔레그램 알림을 꺼 두면(기본값) 라운드가 끝나도 조용하다', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({
      [HOST]: ['설계안: 세션 토큰 사용\n@Claude2'],
      [REVIEWER]: ['확인했습니다.\n[DONE]'],
    }, calls));

    // notifyTelegram 은 건드리지 않는다 — 기본값(꺼짐) 그대로 둔다.
    const sent: string[] = [];
    const bridge = startTelegramBridge({
      botToken: 'test-token',
      allowedChatIds: [4242],
      runtime: {
        hasRuntime: () => true,
        run: async () => {},
        abort: async () => true,
        resolveToolApproval: () => {},
        getPendingApprovalsForSession: () => [],
      } as never,
      client: createFakeTelegramClient(sent),
    });

    try {
      roomsService.postUserMessage(ROOM_ID, { content: '로그인 기능 설계해줘' }, 1);
      await waitFor(() => speakers().length === 3 && isIdle(), 'two turns');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(sent, []);
    } finally {
      bridge.stop();
    }
  });
});
