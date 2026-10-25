import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTurnPrompt,
  findFirstMention,
  isValidRoomDisplayName,
  nextParticipantAfter,
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
    ...extra,
  };
}

function message(id: number, speaker: string, text: string): RoomMessage {
  return { id, roomId: 'room', speaker, text, status: 'complete', sessionId: null, createdAt: '' };
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
