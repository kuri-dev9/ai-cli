import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTurnPrompt,
  findFirstMention,
  isValidRoomDisplayName,
  nextParticipantAfter,
  parseAssignments,
  parseHandoff,
  pickSpeakerForUserMessage,
} from '@/modules/rooms/services/room-prompt.service.js';
import type { RoomMessage, RoomParticipant } from '@/shared/types.js';

function participant(id: string, displayName: string, position: number, extra: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    participantId: id,
    roomId: 'room',
    sessionId: `session-${id}`,
    provider: 'claude',
    model: null,
    displayName,
    roleName: `role-${id}`,
    rolePrompt: '',
    position,
    isHost: position === 0,
    permissionMode: 'ask',
    ...extra,
  };
}

function message(id: number, speaker: string, text: string): RoomMessage {
  return { id, roomId: 'room', speaker, text, status: 'complete', sessionId: null, attachments: [], finalText: null, handoff: null, turnKind: null, task: null, createdAt: '' };
}

// 같은 Claude 라도 역할이 다르면 별개의 참가자다. 이름이 앞부분까지 겹친다.
const host = participant('a', 'Claude', 0, { roleName: '설계자' });
const reviewer = participant('b', 'Claude2', 1, { roleName: '리뷰어' });
const coder = participant('c', 'Codex', 2, { provider: 'codex', roleName: '구현' });
const everyone = [host, reviewer, coder];

test('a mention picks the exact participant, not one whose name is a prefix', () => {
  assert.equal(findFirstMention('@Claude2 이거 봐줘', everyone)?.participantId, 'b');
  assert.equal(findFirstMention('@claude 먼저', everyone)?.participantId, 'a');
  assert.equal(findFirstMention('@Codex 다음 @Claude', everyone)?.participantId, 'c');
  assert.equal(findFirstMention('메일은 a@b.com', everyone), null);
  assert.equal(findFirstMention('메일은 me@Codex.dev', everyone), null);
});

test('a Korean name is recognized even with a particle attached', () => {
  const builder = participant('k1', '빌더', 0);
  const builder2 = participant('k2', '빌더2', 1);
  const korean = [builder, builder2];
  assert.equal(findFirstMention('@빌더가 고쳐줘', korean)?.participantId, 'k1');
  assert.equal(findFirstMention('@빌더2는 테스트', korean)?.participantId, 'k2');
  assert.equal(findFirstMention('(@빌더) 확인', korean)?.participantId, 'k1');
  assert.deepEqual(parseHandoff('수정 끝.\n@빌더2에게 넘깁니다', korean, 'k1'), { kind: 'mention', participantId: 'k2' });
});

test('handoff reads DONE before PASS before a mention, and ignores self mentions', () => {
  assert.deepEqual(parseHandoff('구현했어요.\n@Codex [DONE]', everyone, 'a'), { kind: 'done' });
  assert.deepEqual(parseHandoff('할 말 없음\n[pass]', everyone, 'a'), { kind: 'pass' });
  assert.deepEqual(parseHandoff('리뷰 부탁해요.\n@Claude2', everyone, 'a'), { kind: 'mention', participantId: 'b' });
  assert.deepEqual(parseHandoff('제가 계속할게요 @Claude', everyone, 'a'), { kind: 'none' });
  // 마지막 몇 줄만 본다. 본문 앞쪽의 멘션은 넘김이 아니다.
  assert.deepEqual(parseHandoff('@Codex 가 말한 대로\n1\n2\n3\n끝', everyone, 'a'), { kind: 'none' });
});

test('round robin goes in position order and wraps', () => {
  assert.equal(nextParticipantAfter(everyone, 'a')?.participantId, 'b');
  assert.equal(nextParticipantAfter(everyone, 'c')?.participantId, 'a');
  assert.equal(nextParticipantAfter([host], 'a'), null);
});

test('a user message goes to the mentioned participant, otherwise the host', () => {
  assert.equal(pickSpeakerForUserMessage('@Codex 테스트 짜줘', everyone)?.participantId, 'c');
  assert.equal(pickSpeakerForUserMessage('다들 어떻게 생각해?', everyone)?.participantId, 'a');
});

test('the first turn carries the role brief; later turns only a reminder and the delta', () => {
  const first = buildTurnPrompt({
    me: reviewer,
    participants: everyone,
    delta: [message(1, 'user', '로그인 기능 만들어줘'), message(2, 'a', '설계안입니다')],
    isFirstTurn: true,
    priorContext: '[사용자] 예전 이야기',
  });
  assert.match(first, /"@Claude2" 입니다\. 역할: 리뷰어/);
  assert.match(first, /@Claude: 설계자/);
  assert.match(first, /@Codex: 구현 \(codex\)/);
  assert.match(first, /\[사용자\]\n로그인 기능 만들어줘/);
  assert.match(first, /\[Claude\(설계자\)\]\n설계안입니다/);
  assert.match(first, /예전 이야기/);

  const later = buildTurnPrompt({ me: reviewer, participants: everyone, delta: [], isFirstTurn: false });
  assert.doesNotMatch(later, /함께 일하는 참가자/);
  assert.match(later, /새 메시지 없음/);
});

test('display names reject spaces, @ and brackets', () => {
  assert.equal(isValidRoomDisplayName('리뷰어'), true);
  assert.equal(isValidRoomDisplayName('Claude-2'), true);
  assert.equal(isValidRoomDisplayName('two words'), false);
  assert.equal(isValidRoomDisplayName('@me'), false);
  assert.equal(isValidRoomDisplayName('[x]'), false);
  assert.equal(isValidRoomDisplayName(''), false);
});

test('assignment lines hand out work, merge per participant, and allow only one editor', () => {
  const assignments = parseAssignments([
    '이렇게 나눕니다.',
    '- [작업 @Claude2 수정] 테스트 작성',
    '1. [작업 @Codex 수정] 구현',
    '[TASK @claude] 문서 정리',
    '[작업 @Claude2] 커버리지 확인',
    '[작업 @없는사람] 무시된다',
    '본문 속 [작업 @Codex] 표시는 줄 머리가 아니라서 무시된다',
  ].join('\n'), everyone);

  assert.deepEqual(assignments, [
    { participantId: 'b', task: { text: '테스트 작성\n커버리지 확인', canEdit: true } },
    // 수정은 먼저 맡은 한 명뿐이다. 같은 폴더를 둘이 동시에 고치면 덮어쓴다.
    { participantId: 'c', task: { text: '구현', canEdit: false } },
    { participantId: 'a', task: { text: '문서 정리', canEdit: false } },
  ]);
  assert.deepEqual(parseAssignments('나눌 일이 없어요 @Claude2', everyone), []);
});

test('each turn mode adds its own instructions', () => {
  const base = { me: host, participants: everyone, delta: [message(1, 'user', '해줘')], isFirstTurn: false };
  assert.match(buildTurnPrompt({ ...base, mode: { kind: 'plan' } }), /\[작업 @이름 수정\]/);
  assert.match(
    buildTurnPrompt({ ...base, mode: { kind: 'task', task: { text: '조사', canEdit: false }, leadName: 'Claude2' } }),
    /@Claude2 가 맡긴 일입니다: 조사[\s\S]*파일 수정: 불가/,
  );
  assert.match(buildTurnPrompt({ ...base, mode: { kind: 'comment', onName: 'Codex' } }), /방금 @Codex 의 답/);
  assert.match(buildTurnPrompt({ ...base, mode: { kind: 'summary' } }), /\[정리\]/);
  assert.doesNotMatch(buildTurnPrompt(base), /\[분담\]|\[맡은 일\]|\[의견\]|\[정리\]/);
});
