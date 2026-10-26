import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, roomsDb, sessionsDb } from '@/modules/database/index.js';
import { roomsService } from '@/modules/rooms/services/rooms.service.js';
import { roomTurnEngine } from '@/modules/rooms/services/room-turn-engine.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
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

type Call = { sessionId: string; command: string; options: Record<string, unknown> };

type Script = Record<string, Array<string | (() => Promise<string>)>>;

function createRuntime(script: Script, calls: Call[], aborts: string[] = []) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string, options: Record<string, unknown>, writer: ProviderRuntimeWriter) => {
      const sessionId = String(options.sessionId);
      calls.push({ sessionId, command, options });
      const next = script[sessionId]?.shift() ?? '[PASS]';
      const reply = typeof next === 'function' ? await next() : next;
      writer.send(createNormalizedMessage({ kind: 'text', role: 'assistant', content: reply, sessionId, provider: 'claude' }));
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  } as never;
}

async function withRoom(maxAutoTurns: number, runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'room-engine-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(HOST, 'claude', tempDirectory, 'Host', now, now, null);
    sessionsDb.createSession(REVIEWER, 'claude', tempDirectory, 'Reviewer', now, now, null);
    // 같은 Claude 두 세션이 서로 다른 역할로 들어간다.
    roomsDb.createRoom(
      { roomId: ROOM_ID, hostSessionId: HOST, projectPath: tempDirectory, permissionMode: 'ask', maxAutoTurns },
      [
        { participant_id: 'p-host', session_id: HOST, provider: 'claude', model: null, display_name: 'Claude', role_name: '설계자', role_prompt: '', position: 0 },
        { participant_id: 'p-rev', session_id: REVIEWER, provider: 'claude', model: 'sonnet', display_name: 'Claude2', role_name: '리뷰어', role_prompt: '깐깐하게 본다', position: 1 },
      ],
    );
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

test('the room is capped at three participants and names stay unique', async () => {
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

    const now = new Date().toISOString();
    sessionsDb.createSession('third', 'claude', '/tmp', 'Third', now, now, null);
    roomsDb.addParticipant({
      participant_id: 'p-3', room_id: ROOM_ID, session_id: 'third', provider: 'claude', model: null,
      display_name: 'Tester', role_name: '테스터', role_prompt: '', position: 2,
    });
    await assert.rejects(
      roomsService.addParticipant(ROOM_ID, { provider: 'claude', displayName: 'Four', roleName: '넷째' }),
      (error: Error & { code?: string }) => error.code === 'ROOM_FULL',
    );
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

test('a participant can leave, but the host cannot', async () => {
  await withRoom(6, async () => {
    assert.throws(
      () => roomsService.removeParticipant(ROOM_ID, 'p-host'),
      (error: Error & { code?: string }) => error.code === 'HOST_CANNOT_LEAVE',
    );

    const detail = roomsService.removeParticipant(ROOM_ID, 'p-rev');
    assert.deepEqual(detail.participants.map((participant) => participant.participantId), ['p-host']);
    assert.deepEqual(detail.formerParticipants.map((participant) => participant.participantId), ['p-rev']);
    // 나간 세션은 다시 평범한 대화로 열린다.
    assert.equal(roomsDb.getParticipantBySession(REVIEWER), null);
    assert.deepEqual(roomsService.listRoomIndex()[0].participants.map((participant) => participant.participantId), ['p-host']);
  });
});
