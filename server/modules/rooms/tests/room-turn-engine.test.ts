import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, roomsDb, sessionsDb } from '@/modules/database/index.js';
import { roomsService } from '@/modules/rooms/services/rooms.service.js';
import { roomTurnEngine } from '@/modules/rooms/services/room-turn-engine.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
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
  collaboration: { splitWork?: boolean; discussion?: boolean; thirdParticipant?: boolean } = {},
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
        { participant_id: 'p-host', session_id: HOST, provider: 'claude', model: null, display_name: 'Claude', role_name: '설계자', role_prompt: '', persona: '', status: 'active', position: 0 },
        { participant_id: 'p-rev', session_id: REVIEWER, provider: 'claude', model: 'sonnet', display_name: 'Claude2', role_name: '리뷰어', role_prompt: '깐깐하게 본다', persona: '', status: 'active', position: 1 },
        ...(collaboration.thirdParticipant
          ? [{ participant_id: 'p-rev2', session_id: SECOND_REVIEWER, provider: 'claude', model: null, display_name: 'Claude3', role_name: '리뷰어2', role_prompt: '', persona: '', status: 'active' as const, position: 2 }]
          : []),
      ],
    );
    roomsDb.updateRoomSettings(ROOM_ID, {
      splitWork: collaboration.splitWork ?? false,
      discussion: collaboration.discussion ?? false,
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

test('a message sent mid-turn is picked up at the next turn and redirects the room', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    let release: () => void = () => {};
    const hostReplyGate = new Promise<void>((resolve) => { release = resolve; });

    roomTurnEngine.initialize(createRuntime({
      [HOST]: [async () => { await hostReplyGate; return '구현 중… @Claude'; }],
      [REVIEWER]: ['테스트부터 보겠습니다 [DONE]'],
    }, calls));

    roomsService.postUserMessage(ROOM_ID, { content: '구현해줘' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');

    const { state } = roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 테스트도 같이 봐줘' }, 1);
    assert.equal(state.status, 'running');
    assert.equal(state.pendingUserMessage, true);
    release();

    await waitFor(() => isIdle() && speakers().length === 4, 'redirected turn');
    // 호스트가 자기 자신을 넘겼더라도 사용자 지목이 이긴다.
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER]);
    assert.match(calls[1].command, /테스트도 같이 봐줘/);
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
        participant_id: `p-${index}`, room_id: ROOM_ID, session_id: null, provider: 'claude', model: null,
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
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null,
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
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null,
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

test('a standby member sits out the rounds it is not called into', async () => {
  await withRoom(4, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['혼자 끝냈습니다 [DONE]'] }, calls));

    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null,
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
      [HOST]: [async () => { await gate; return '길게 쓰던 답 @Claude'; }],
      [REVIEWER]: ['바로 볼게요 [DONE]'],
    }, calls, aborts));

    roomsService.postUserMessage(ROOM_ID, { content: '오래 걸리는 일' }, 1);
    await waitFor(() => calls.length === 1, 'host turn started');
    roomsService.postUserMessage(ROOM_ID, { content: '@Claude2 잠깐, 이것부터' }, 1);

    const interrupting = roomsService.interrupt(ROOM_ID);
    release();
    await interrupting;
    await waitFor(() => isIdle() && speakers().length === 4, 'interrupted round');

    assert.deepEqual(aborts, [HOST]);
    const rows = roomsDb.listMessages(ROOM_ID);
    assert.deepEqual(rows.map((row) => row.speaker), ['user', 'user', 'p-host', 'p-rev']);
    // 끊긴 답은 실패가 아니라 중단이고, 루프는 멈추지 않고 지목된 참가자로 넘어간다.
    assert.equal(rows[2].status, 'aborted');
    assert.equal(rows[3].status, 'complete');
    assert.deepEqual(calls.map((call) => call.sessionId), [HOST, REVIEWER]);
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
  }, { splitWork: true });
});

test('a worked participant goes to standby instead of leaving the room', async () => {
  await withRoom(6, async () => {
    assert.throws(
      () => roomsService.removeParticipant(ROOM_ID, 'p-host'),
      (error: Error & { code?: string }) => error.code === 'HOST_CANNOT_LEAVE',
    );

    const detail = roomsService.removeParticipant(ROOM_ID, 'p-rev');
    // 룸 안에 그대로 남는다. 세션이 프로젝트 목록으로 튀어나오면 룸을 쓸수록
    // 목록이 지저분해진다.
    assert.deepEqual(detail.participants.map((participant) => participant.participantId), ['p-host', 'p-rev']);
    assert.deepEqual(detail.formerParticipants, []);
    assert.equal(detail.participants.find((participant) => participant.participantId === 'p-rev')?.status, 'standby');
    // 세션도 룸 참가자로 남아 사이드바에서 룸 밑에 접힌다.
    assert.equal(roomsDb.getParticipantBySession(REVIEWER)?.participant_id, 'p-rev');
    assert.deepEqual(
      roomsService.listRoomIndex()[0].participants.map((participant) => participant.participantId),
      ['p-host', 'p-rev'],
    );
  });
});

test('a standby participant comes back when it is mentioned again', async () => {
  await withRoom(6, async () => {
    const calls: Call[] = [];
    roomTurnEngine.initialize(createRuntime({ [HOST]: ['다시 봐줘 @Claude2'], [REVIEWER]: ['[DONE]'] }, calls));

    roomsService.removeParticipant(ROOM_ID, 'p-rev');
    roomsService.postUserMessage(ROOM_ID, { content: '시작' }, 1);
    await waitFor(() => isIdle() && speakers().includes('p-rev'), 'the recalled turn');

    // 같은 세션이 돌아온다. 새로 만들지 않으므로 하던 이야기를 기억한다.
    assert.ok(calls.some((call) => call.sessionId === REVIEWER));
    assert.equal(roomsService.getRoomDetail(ROOM_ID).participants.find((p) => p.participantId === 'p-rev')?.sessionId, REVIEWER);
  });
});

test('a roster member that was never called is dropped outright, freeing its name', async () => {
  await withRoom(6, async () => {
    roomsDb.addParticipant({
      participant_id: 'p-roster', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null,
      display_name: '체커', role_name: '리뷰어', role_prompt: '', persona: '', status: 'standby', position: 2,
    });

    const detail = roomsService.removeParticipant(ROOM_ID, 'p-roster');
    assert.deepEqual(detail.participants.map((participant) => participant.participantId), ['p-host', 'p-rev']);
    // 행이 사라졌으므로 같은 이름을 다시 쓸 수 있다.
    assert.deepEqual(detail.formerParticipants, []);
    roomsDb.addParticipant({
      participant_id: 'p-again', room_id: ROOM_ID, session_id: null, provider: 'claude', model: null,
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
