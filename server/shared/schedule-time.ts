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
