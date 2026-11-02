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
  pickSpeakersForUserMessage,
} from '@/modules/rooms/services/room-prompt.service.js';
import type { RoomMessage, RoomParticipant } from '@/shared/types.js';

function participant(id: string, displayName: string, position: number, extra: Partial<RoomParticipant> = {}): RoomParticipant {
  return {
    participantId: id,
    roomId: 'room',
    sessionId: `session-${id}`,
    provider: 'claude',
    model: null,
    effort: null,
    claudeAccountId: null,
    displayName,
    roleName: `role-${id}`,
    rolePrompt: '',
    persona: '',
    status: 'active',
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

test('handoff follows the last line, not a name mentioned on the lines above it', () => {
  // 실제 룸에서 @헤일리를 불렀는데 위 줄의 @패트릭이 잡혀 패트릭이 다시 불렸다.
  assert.deepEqual(
    parseHandoff('@Claude2, 확인했습니다.\n마지막으로 @Codex를 부릅니다.\n@Codex', everyone, 'a'),
    { kind: 'mention', participantId: 'c' },
  );
  // 앞 줄에서 남의 [PASS] 를 인용했다고 라운드가 끝나면 안 된다.
  assert.deepEqual(
    parseHandoff('@Claude2의 [PASS]만 올라왔습니다.\n@Codex, 한 줄로 답해 주세요.\n@Codex', everyone, 'a'),
    { kind: 'mention', participantId: 'c' },
  );
  // 한 줄에 여럿이면 마지막 멘션이 넘김이다.
  assert.deepEqual(parseHandoff('@Claude2 확인 고마워요. 다음은 @Codex', everyone, 'a'), { kind: 'mention', participantId: 'c' });
  // 넘김 뒤에 덧붙인 줄은 건너뛰고 위 줄의 표시를 따른다.
  assert.deepEqual(parseHandoff('구현했어요.\n@Claude2\n(참고: 테스트는 통과)', everyone, 'a'), { kind: 'mention', participantId: 'b' });
  assert.deepEqual(parseHandoff('다음은 me@Codex.dev 로 메일', everyone, 'a'), { kind: 'none' });
});

test('a last line of names alone calls them all at once; names inside a sentence do not', () => {
  assert.deepEqual(parseHandoff('둘에게 묻습니다\n@Claude2 @Codex', everyone, 'a'), { kind: 'group', participantIds: ['b', 'c'] });
  assert.deepEqual(parseHandoff('둘에게 묻습니다\n@Claude2, @Codex', everyone, 'a'), { kind: 'group', participantIds: ['b', 'c'] });
  // 같은 이름을 두 번 적거나 자기를 섞어도 남는 상대가 하나면 평범한 넘김이다.
  assert.deepEqual(parseHandoff('@Claude2 @Claude2', everyone, 'a'), { kind: 'mention', participantId: 'b' });
  assert.deepEqual(parseHandoff('@Claude @Claude2', everyone, 'a'), { kind: 'mention', participantId: 'b' });
  // 문장 속 이름은 동시 호출이 아니다. 마지막 이름에게만 넘긴다.
  assert.deepEqual(parseHandoff('@Claude2 확인 고마워요. 다음은 @Codex', everyone, 'a'), { kind: 'mention', participantId: 'c' });
});

test('a user message naming several participants goes to all of them', () => {
  assert.deepEqual(pickSpeakersForUserMessage('@Claude2 @Codex 자기소개 해줘', everyone).map((p) => p.participantId), ['b', 'c']);
  assert.deepEqual(pickSpeakersForUserMessage('@Codex 테스트 짜줘', everyone).map((p) => p.participantId), ['c']);
  assert.deepEqual(pickSpeakersForUserMessage('다들 어떻게 생각해?', everyone).map((p) => p.participantId), ['a']);
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
  assert.doesNotMatch(later, /지금 룸에 있는 참가자/);
  assert.match(later, /새 메시지 없음/);
});

test('a changed role is briefed again on the next turn, flagged as a change', () => {
  const changed = participant('b', '체커', 1, {
    roleName: '리뷰어',
    rolePrompt: '버그만 번호로 짚는다',
    persona: '깐깐하고 의심이 많다',
  });
  const after = buildTurnPrompt({
    me: changed,
    participants: [host, changed, coder],
    delta: [],
    isFirstTurn: false,
    roleChanged: true,
  });
  // 첫 차례가 아닌데도 역할 안내가 통째로 다시 나가고, 바뀌었다는 표시가 붙는다.
  assert.match(after, /\[바뀜\]/);
  assert.match(after, /"@체커" 입니다\. 역할: 리뷰어/);
  assert.match(after, /역할 설명: 버그만 번호로 짚는다/);
  assert.match(after, /성향: 깐깐하고 의심이 많다/);
  assert.match(after, /지금 룸에 있는 참가자/);

  // 첫 차례에는 바뀜 표시 없이 같은 안내가 나간다.
  const first = buildTurnPrompt({ me: changed, participants: [host, changed, coder], delta: [], isFirstTurn: true });
  assert.doesNotMatch(first, /\[바뀜\]/);
  assert.match(first, /성향: 깐깐하고 의심이 많다/);

  // 바뀐 게 없으면 예전처럼 짧은 알림만 나간다.
  const quiet = buildTurnPrompt({ me: changed, participants: [host, changed, coder], delta: [], isFirstTurn: false });
  assert.doesNotMatch(quiet, /지금 룸에 있는 참가자/);
  assert.doesNotMatch(quiet, /성향:/);
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
