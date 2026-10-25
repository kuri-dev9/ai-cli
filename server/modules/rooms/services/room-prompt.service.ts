import type { RoomMessage, RoomParticipant } from '@/shared/types.js';

/**
 * 룸 턴에 보낼 프롬프트를 만들고, 돌아온 답에서 "다음은 누구"를 읽는다.
 *
 * 전부 순수 함수다. 턴 엔진이 쓰고, 테스트가 그대로 부른다.
 */

/** 답의 끝에서 넘김 표시를 찾을 줄 수. 끝맺음 뒤에 한두 줄 덧붙이는 일이 흔하다. */
const HANDOFF_TAIL_LINES = 3;

/** 새로 들어온 참가자에게 넘기는 룸 대화 수. 그보다 앞은 생략한다. */
const MAX_DELTA_MESSAGES = 30;

/** 한 메시지를 프롬프트에 옮길 때의 최대 길이. 긴 답 하나가 프롬프트를 다 먹지 않게. */
const MAX_MESSAGE_CHARS = 4000;

export const ROOM_DONE_MARKER = '[DONE]';
export const ROOM_PASS_MARKER = '[PASS]';

/** `@이름` 으로 부를 수 있는 이름인지. 공백·`@`·대괄호는 멘션을 깨뜨린다. */
export function isValidRoomDisplayName(name: string): boolean {
  return /^[^\s@[\]]{1,24}$/u.test(name);
}

function describeSpeaker(speaker: string, participants: RoomParticipant[]): string {
  if (speaker === 'user') {
    return '사용자';
  }
  const participant = participants.find((candidate) => candidate.participantId === speaker);
  return participant ? `${participant.displayName}(${participant.roleName})` : '알 수 없는 참가자';
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…(생략)` : text;
}

/**
 * 처음 차례에 붙이는 역할 안내. 세션이 자기 대화를 이어가므로 이후 차례에는
 * 짧은 알림만 붙인다.
 */
export function buildRoleBrief(me: RoomParticipant, participants: RoomParticipant[]): string {
  const others = participants
    .filter((participant) => participant.participantId !== me.participantId)
    .map((participant) => `- @${participant.displayName}: ${participant.roleName} (${participant.provider})`)
    .join('\n');
  const rolePrompt = me.rolePrompt.trim() ? `\n역할 설명: ${me.rolePrompt.trim()}` : '';

  return [
    `[팀 룸] 당신은 이 룸의 참가자 "@${me.displayName}" 입니다. 역할: ${me.roleName}.${rolePrompt}`,
    '',
    '함께 일하는 참가자:',
    others || '- (아직 없음)',
    '- 사용자: 룸의 주인. 언제든 끼어들어 방향을 바꿉니다.',
    '',
    '규칙:',
    '- 당신의 역할 범위에서 일하세요. 다른 참가자의 일을 대신하지 말고, 필요하면 그 참가자에게 요청하세요.',
    '- 같은 폴더에서 차례로 작업합니다. 다른 참가자가 고친 파일은 다시 읽고 이어서 작업하세요.',
    '- 답은 다른 참가자가 읽고 이어받기 쉽게, 한 일과 결론을 요약해 쓰세요.',
    '- 사용자의 지시가 다른 참가자의 의견보다 우선합니다.',
    `- 답의 마지막 줄에는 반드시 다음 중 하나만 쓰세요: "@이름"(그 참가자에게 넘김), "${ROOM_PASS_MARKER}"(덧붙일 말 없음), "${ROOM_DONE_MARKER}"(작업이 끝나 사용자 확인이 필요함).`,
  ].join('\n');
}

function buildReminder(me: RoomParticipant): string {
  return `[팀 룸] 당신은 "@${me.displayName}"(${me.roleName}) 입니다. 마지막 줄에 "@이름", "${ROOM_PASS_MARKER}", "${ROOM_DONE_MARKER}" 중 하나를 쓰세요.`;
}

/**
 * 한 차례에 보낼 프롬프트.
 *
 * `delta` 는 이 참가자가 아직 읽지 않은 룸 메시지다(자기 답은 빠져 있어야 한다).
 * 세션이 자기 맥락을 이어가므로 이미 본 것은 다시 보내지 않는다.
 *
 * `priorContext` 는 새로 초대된 참가자에게만 준다. 룸이 되기 전 원래 대화의
 * 마지막 부분이다.
 */
export function buildTurnPrompt(input: {
  me: RoomParticipant;
  participants: RoomParticipant[];
  delta: RoomMessage[];
  isFirstTurn: boolean;
  priorContext?: string | null;
}): string {
  const { me, participants, isFirstTurn } = input;
  const delta = input.delta.slice(-MAX_DELTA_MESSAGES);
  const omitted = input.delta.length - delta.length;

  const sections: string[] = [isFirstTurn ? buildRoleBrief(me, participants) : buildReminder(me)];

  if (input.priorContext?.trim()) {
    sections.push(`룸이 되기 전 원래 대화의 마지막 부분:\n${input.priorContext.trim()}`);
  }

  const lines = delta.map(
    (message) => `[${describeSpeaker(message.speaker, participants)}]\n${clip(message.text, MAX_MESSAGE_CHARS)}`,
  );
  const header = isFirstTurn ? '지금까지 룸의 대화:' : '지난 차례 이후 룸에 올라온 대화:';
  sections.push(
    `${header}${omitted > 0 ? ` (앞의 ${omitted}개 생략)` : ''}\n\n${lines.length ? lines.join('\n\n') : '(새 메시지 없음)'}`,
  );
  sections.push(`이제 @${me.displayName} 의 차례입니다.`);

  return sections.join('\n\n---\n\n');
}

export type RoomHandoff =
  | { kind: 'done' }
  | { kind: 'pass' }
  | { kind: 'mention'; participantId: string }
  | { kind: 'none' };

/**
 * 글에서 처음 나오는 참가자 멘션.
 *
 * 이름 뒤에 조사가 붙어도 잡는다(`@빌더가 고쳐줘`). 대신 같은 자리에서 맞는
 * 이름이 여럿이면 가장 긴 것을 고른다 — 그래야 `@Claude2` 가 `@Claude` 로
 * 잡히지 않는다. `@` 앞에 글자가 붙어 있으면 메일 주소 같은 것이라 보지 않는다.
 */
export function findFirstMention(text: string, participants: RoomParticipant[]): RoomParticipant | null {
  const haystack = text.toLowerCase();
  const byLength = [...participants].sort((a, b) => b.displayName.length - a.displayName.length);

  for (let index = haystack.indexOf('@'); index >= 0; index = haystack.indexOf('@', index + 1)) {
    const before = haystack.charAt(index - 1);
    if (before && /[\p{L}\p{N}_.-]/u.test(before)) {
      continue;
    }
    const rest = haystack.slice(index + 1);
    const match = byLength.find((participant) => rest.startsWith(participant.displayName.toLowerCase()));
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * 답의 마지막 몇 줄에서 넘김 표시를 읽는다.
 *
 * `[DONE]` 이 `[PASS]` 보다, 둘 다 멘션보다 앞선다 — "끝났다"는 말이 가장 강한
 * 신호다. 자기 자신을 부른 멘션은 무시한다.
 */
export function parseHandoff(text: string, participants: RoomParticipant[], selfId: string): RoomHandoff {
  const tail = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-HANDOFF_TAIL_LINES)
    .join('\n');

  if (tail.toUpperCase().includes(ROOM_DONE_MARKER)) {
    return { kind: 'done' };
  }
  if (tail.toUpperCase().includes(ROOM_PASS_MARKER)) {
    return { kind: 'pass' };
  }
  const others = participants.filter((participant) => participant.participantId !== selfId);
  const mentioned = findFirstMention(tail, others);
  return mentioned ? { kind: 'mention', participantId: mentioned.participantId } : { kind: 'none' };
}

/** 순서상 다음 참가자. 혼자 남은 룸이면 null. */
export function nextParticipantAfter(participants: RoomParticipant[], currentId: string): RoomParticipant | null {
  if (participants.length < 2) {
    return null;
  }
  const ordered = [...participants].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((participant) => participant.participantId === currentId);
  return ordered[(index + 1) % ordered.length] ?? null;
}

/**
 * 사용자 메시지를 누가 먼저 받을지. 멘션이 있으면 그 참가자, 없으면 원래
 * 대화(호스트)가 받는다 — 사용자가 늘 이야기하던 상대가 먼저 답하는 게 자연스럽다.
 */
export function pickSpeakerForUserMessage(text: string, participants: RoomParticipant[]): RoomParticipant | null {
  const mentioned = findFirstMention(text, participants);
  if (mentioned) {
    return mentioned;
  }
  return participants.find((participant) => participant.isHost)
    ?? [...participants].sort((a, b) => a.position - b.position)[0]
    ?? null;
}
