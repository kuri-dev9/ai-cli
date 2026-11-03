/**
 * 사람이 적은 예약 시각을 읽는다. `/예약` 명령과, 룸 참가자가 답에 남긴
 * `[예약 …]` 줄이 같이 쓴다.
 *
 * 서버의 현지 시각 기준이다 — 사용자도 참가자도 벽시계 시각을 그대로 적는다.
 */

/**
 * 시각만 적었는데 이만큼 안쪽으로 이미 지났으면 내일이 아니라 지금으로 본다.
 * "14:45 에 해 줘" 라고 한 답이 14:45 를 살짝 넘겨 끝나면 하루 뒤로 밀리던 것을 막는다.
 */
const RECENTLY_PASSED_MS = 10 * 60 * 1000;

const RELATIVE = /^\+?\s*(\d+)\s*(분|m|min|mins|minutes?|시간|h|hr|hrs|hours?)(?:\s*(?:뒤|후|later))?(?=\s|$)/iu;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?=\s|$)/u;
const CLOCK = /^(\d{1,2}):(\d{2})(?=\s|$)/u;

/**
 * 글 맨 앞의 예약 시각을 읽고 나머지를 돌려준다. 시각을 못 읽으면 null.
 *
 * "+20분", "20분 뒤", "2시간 후", "14:50", "2026-11-02 14:50" 을 받는다.
 */
export function splitScheduleSpec(text: string, now: Date): { at: Date; rest: string } | null {
  const value = text.trimStart();

  const relative = RELATIVE.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = /^(시간|h|hr|hrs|hours?)$/iu.test(relative[2]) ? 60 * 60 * 1000 : 60 * 1000;
    return { at: new Date(now.getTime() + amount * unitMs), rest: value.slice(relative[0].length).trim() };
  }

  const absolute = DATE_TIME.exec(value);
  if (absolute) {
    const [, year, month, day, hour, minute] = absolute.map(Number);
    if (hour > 23 || minute > 59) return null;
    return { at: new Date(year, month - 1, day, hour, minute), rest: value.slice(absolute[0].length).trim() };
  }

  const clock = CLOCK.exec(value);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (at.getTime() <= now.getTime()) {
      if (now.getTime() - at.getTime() <= RECENTLY_PASSED_MS) {
        // 방금 지난 시각이다. 다음 확인 때 바로 나가게 지금으로 둔다.
        at = new Date(now.getTime());
      } else {
        at.setDate(at.getDate() + 1);
      }
    }
    return { at, rest: value.slice(clock[0].length).trim() };
  }

  return null;
}

/** 시각만 적힌 글을 읽는다. 시각 뒤에 다른 말이 붙어 있으면 null. */
export function parseScheduleTime(spec: string, now: Date): Date | null {
  const split = splitScheduleSpec(spec, now);
  return split && !split.rest ? split.at : null;
}

/** 한 답에서 받는 예약 수. 실수로 줄줄이 적은 예약이 대화를 뒤덮지 않게. */
const MAX_SCHEDULES_PER_REPLY = 5;
/** 예약할 수 있는 가장 먼 시각. 그보다 먼 것은 거의 틀림없이 잘못 읽은 시각이다. */
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 예약 줄. 목록 기호(`-`, `1.`), 인용(`>`), 굵게(`**`), 코드(`` ` ``)로 감싸 써도
 * 읽는다 — 꾸며 쓴 줄을 놓쳐 예약이 말없이 사라지는 일이 실제로 있었다.
 */
const SCHEDULE_LINE = /^[\s>*_`-]*(?:\d+[.)]\s*)?[*_`]*\[(?:예약|schedule)\s+([^\]]+?)\s*\][*_`]*\s*(.+?)[*_`]*\s*$/iu;

/** `[예약취소 #a1b2c3]`. 번호는 예약 목록에 붙은 짧은 번호다. 여러 개를 한 줄에 적어도 된다. */
const SCHEDULE_CANCEL_LINE = /\[(?:예약\s*취소|cancel\s*schedule|unschedule)\s+((?:#?[0-9a-f]{4,}[\s,]*)+)\]/giu;

/** 예약 번호. 화면의 예약 목록과 프롬프트, 취소 줄이 같은 길이를 쓴다. */
export function shortScheduleId(id: string): string {
  return id.replace(/-/g, '').slice(0, 6);
}

/**
 * AI 답에서 예약 줄(`[예약 14:50] 할 일`)을 읽는다. 지난 시각이나 너무 먼 시각,
 * 못 읽는 시각은 버리고, 같은 시각·같은 할 일은 한 번만 센다.
 */
export function parseScheduleLines(text: string, now: Date): Array<{ at: Date; task: string }> {
  const schedules: Array<{ at: Date; task: string }> = [];
  for (const line of text.split('\n')) {
    const match = SCHEDULE_LINE.exec(line);
    if (!match) continue;
    const at = parseScheduleTime(match[1], now);
    // 방금 지난 시각은 읽는 쪽이 지금으로 바꿔 준다. 그보다 이른 것은 버린다.
    if (!at || at.getTime() < now.getTime() || at.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) continue;
    const task = match[2].trim();
    if (!task) continue;
    // 작업 중에 남긴 말과 마지막 말에 같은 줄을 두 번 쓰는 일이 흔하다.
    if (schedules.some((schedule) => schedule.task === task && schedule.at.getTime() === at.getTime())) continue;
    schedules.push({ at, task });
    if (schedules.length >= MAX_SCHEDULES_PER_REPLY) break;
  }
  return schedules;
}

/** 답에서 취소할 예약 번호들을 읽는다. 앞의 `#` 은 떼고 소문자로 맞춘다. */
export function parseScheduleCancels(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(SCHEDULE_CANCEL_LINE)) {
    for (const token of match[1].split(/[\s,]+/)) {
      const id = token.replace(/^#/, '').toLowerCase();
      if (id.length >= 4) ids.add(id);
    }
  }
  return [...ids];
}
