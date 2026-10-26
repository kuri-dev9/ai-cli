import type { RoomMessage, RoomParticipant, RoomTask } from '@/shared/types.js';

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

/** 의견 한 번의 길이. 의견은 일이 아니라 덧붙임이라 짧아야 다음 차례를 늦추지 않는다. */
const COMMENT_MAX_LINES = 5;

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
 * 역할 안내. 처음 차례에 붙이고, 사용자가 누군가의 이름·역할·성향을 고친
 * 뒤에도 다시 붙인다. 세션은 첫 차례에 들은 역할을 기억할 뿐이라, 다시 보내지
 * 않으면 고친 내용이 영영 닿지 않는다.
 *
 * 그 사이 차례에는 짧은 알림(`buildReminder`)만 붙는다.
 */
export function buildRoleBrief(
  me: RoomParticipant,
  participants: RoomParticipant[],
  reason: 'first' | 'changed' = 'first',
  standby: RoomParticipant[] = [],
): string {
  const others = participants
    .filter((participant) => participant.participantId !== me.participantId)
    .map((participant) => `- @${participant.displayName}: ${participant.roleName} (${participant.provider})`)
    .join('\n');
  const callable = standby
    .filter((participant) => participant.participantId !== me.participantId)
    .map((participant) => `- @${participant.displayName}: ${participant.roleName} (${participant.provider})`)
    .join('\n');
  const rolePrompt = me.rolePrompt.trim() ? `\n역할 설명: ${me.rolePrompt.trim()}` : '';
  const persona = me.persona.trim() ? `\n성향: ${me.persona.trim()}` : '';
  const changedNotice = reason === 'changed'
    ? '[바뀜] 사용자가 룸의 참가자 설정을 고쳤습니다. 지금까지의 안내는 잊고 아래 내용을 따르세요.\n\n'
    : '';

  return [
    `${changedNotice}[팀 룸] 당신은 이 룸의 참가자 "@${me.displayName}" 입니다. 역할: ${me.roleName}.${rolePrompt}${persona}`,
    '',
    '지금 룸에 있는 참가자:',
    others || '- (아직 없음)',
    '- 사용자: 룸의 주인. 언제든 끼어들어 방향을 바꿉니다.',
    ...(callable
      ? [
        '',
        '부를 수 있는 멤버 (아직 룸에 없습니다. `@이름` 으로 부르면 그때 들어와 답합니다):',
        callable,
      ]
      : []),
    '',
    '규칙:',
    '- 당신의 역할 범위에서 일하세요. 다른 참가자의 일을 대신하지 말고, 필요하면 그 참가자에게 요청하세요.',
    '- 같은 폴더를 씁니다. 여럿이 동시에 일할 때 파일을 고칠 수 있는 건 맡은 일에 "수정"이 붙은 한 명뿐입니다. 다른 참가자가 고친 파일은 다시 읽고 이어서 작업하세요.',
    '- 답은 다른 참가자가 읽고 이어받기 쉽게, 한 일과 결론을 요약해 쓰세요.',
    '- 사용자의 지시가 다른 참가자의 의견보다 우선합니다.',
    `- 답의 마지막 줄에는 반드시 다음 중 하나만 쓰세요: "@이름"(그 참가자에게 넘김), "${ROOM_PASS_MARKER}"(덧붙일 말 없음), "${ROOM_DONE_MARKER}"(작업이 끝나 사용자 확인이 필요함).`,
  ].join('\n');
}

function buildReminder(me: RoomParticipant, standby: RoomParticipant[] = []): string {
  // 명단은 그 사이에 바뀔 수 있어 짧은 알림에도 함께 적는다. 부를 상대를 모르면
  // 부르지 못한다.
  const callable = standby
    .filter((participant) => participant.participantId !== me.participantId)
    .map((participant) => `@${participant.displayName}(${participant.roleName})`)
    .join(', ');
  const callableLine = callable ? `\n부를 수 있는 멤버: ${callable}` : '';
  return `[팀 룸] 당신은 "@${me.displayName}"(${me.roleName}) 입니다. 마지막 줄에 "@이름", "${ROOM_PASS_MARKER}", "${ROOM_DONE_MARKER}" 중 하나를 쓰세요.${callableLine}`;
}

/**
 * 이번 차례에 무엇을 하는지. 보통의 차례(`turn`) 외에, 일을 나눌 수 있는 첫
 * 차례(`plan`), 맡은 일(`task`), 남의 답에 대한 의견(`comment`), 맡긴 일의
 * 결과를 모으는 정리(`summary`)가 있다.
 */
export type RoomTurnMode =
  | { kind: 'turn' }
  | { kind: 'plan' }
  | { kind: 'task'; task: RoomTask; leadName: string }
  | { kind: 'comment'; onName: string }
  | { kind: 'summary' };

function buildModeInstructions(mode: RoomTurnMode, others: RoomParticipant[]): string | null {
  switch (mode.kind) {
    case 'plan':
      return [
        '[분담] 이 요청을 참가자들과 나눠서 할 수 있습니다. 혼자 하는 편이 빠른 작은 일이면 나누지 말고 바로 하세요.',
        '나눌 때는 답에 한 줄씩 적습니다:',
        '[작업 @이름] 할 일',
        '파일을 고쳐야 하는 일은 "[작업 @이름 수정] 할 일" 로 적습니다. 수정은 한 명에게만 맡기세요. 나머지는 읽기·조사만 합니다.',
        `맡길 수 있는 참가자: ${others.map((participant) => `@${participant.displayName}(${participant.roleName})`).join(', ') || '(없음)'}, 그리고 당신 자신.`,
        '맡긴 일은 동시에 진행되고, 모두 끝나면 결과를 모아 당신에게 다시 차례가 옵니다. 일을 나눴다면 마지막 줄의 넘김 표시는 쓰지 않아도 됩니다.',
      ].join('\n');
    case 'task':
      return [
        `[맡은 일] @${mode.leadName} 가 맡긴 일입니다: ${mode.task.text}`,
        mode.task.canEdit
          ? '파일 수정: 당신이 이번 분담의 수정 담당입니다. 필요한 파일을 고쳐도 됩니다.'
          : '파일 수정: 불가. 읽기·조사만 하세요. 고칠 게 보이면 무엇을 어떻게 고칠지 제안만 하세요.',
        '다른 참가자도 지금 동시에 자기 일을 하고 있습니다. 맡은 일만 하고, 한 일과 결과를 요약해 보고하세요. 넘김 표시는 쓰지 마세요.',
      ].join('\n');
    case 'comment':
      return [
        `[의견] 방금 @${mode.onName} 의 답이 올라왔습니다. 당신의 역할에서 보탤 의견, 우려, 다른 방법이 있으면 ${COMMENT_MAX_LINES}줄 이내로 쓰세요.`,
        `보탤 말이 없으면 "${ROOM_PASS_MARKER}" 한 줄만 쓰세요. 이번에는 파일을 고치거나 긴 작업을 하지 마세요.`,
      ].join('\n');
    case 'summary':
      return [
        '[정리] 맡긴 일의 결과가 모두 모였습니다. 결과를 모아 정리하세요.',
        '더 나눌 일이 있으면 다시 "[작업 @이름] 할 일" 줄로 맡기고, 끝났으면 마지막 줄에 넘김 표시를 쓰세요.',
      ].join('\n');
    default:
      return null;
  }
}

/**
 * 답에서 일을 나눠 맡긴 줄을 읽는다. `[작업 @이름] 할 일`, 고칠 일은
 * `[작업 @이름 수정] 할 일` 이다(영문 `[TASK @name edit]` 도 받는다).
 *
 * 한 참가자에게 여러 줄이면 하나로 합친다. 수정 담당은 처음 나온 한 명만
 * 인정한다 — 같은 폴더를 둘이 동시에 고치면 서로 덮어쓴다.
 */
export function parseAssignments(text: string, participants: RoomParticipant[]): Array<{ participantId: string; task: RoomTask }> {
  const byParticipant = new Map<string, RoomTask>();
  let editorId: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^\s*(?:[-*]\s*|\d+[.)]\s*)?\[(?:작업|task)\s+(@[^\]]+?)\s*\]\s*(.+)$/iu.exec(line);
    if (!match) continue;
    const head = match[1];
    const participant = findFirstMention(head, participants);
    if (!participant) continue;
    const rest = head.slice(1 + participant.displayName.length).trim().toLowerCase();
    const wantsEdit = rest === '수정' || rest === 'edit';
    const taskText = match[2].trim();
    const existing = byParticipant.get(participant.participantId);
    const canEdit = wantsEdit && (editorId === null || editorId === participant.participantId);
    if (canEdit) editorId = participant.participantId;
    byParticipant.set(participant.participantId, {
      text: existing ? `${existing.text}\n${taskText}` : taskText,
      canEdit: Boolean(existing?.canEdit) || canEdit,
    });
  }
  return [...byParticipant.entries()].map(([participantId, task]) => ({ participantId, task }));
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
  /** 사용자가 참가자 설정을 고쳐, 이번 차례에 역할 안내를 다시 보내야 하는지. */
  roleChanged?: boolean;
  /** 명단에서 기다리는 멤버. `@이름` 으로 부르면 들어온다. */
  standby?: RoomParticipant[];
  priorContext?: string | null;
  mode?: RoomTurnMode;
}): string {
  const { me, participants, isFirstTurn } = input;
  const mode = input.mode ?? { kind: 'turn' };
  const delta = input.delta.slice(-MAX_DELTA_MESSAGES);
  const omitted = input.delta.length - delta.length;

  const sections: string[] = [
    // 첫 차례가 아닌데도 안내를 다시 보내는 건 설정이 바뀌었을 때뿐이다.
    isFirstTurn || input.roleChanged
      ? buildRoleBrief(me, participants, isFirstTurn ? 'first' : 'changed', input.standby ?? [])
      : buildReminder(me, input.standby ?? []),
  ];

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
  const instructions = buildModeInstructions(mode, participants.filter((participant) => participant.participantId !== me.participantId));
  if (instructions) {
    sections.push(instructions);
  }
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
