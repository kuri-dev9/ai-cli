import type { Project, ProjectSession } from '@/shared/types';

/**
 * 아직 확인하지 않은 대화의 표시를 브라우저에 남긴다.
 *
 * 이 표시는 원래 메모리에만 있었다. 그래서 답이 도착한 것을 보고 창을 닫았다가
 * 다시 열면 표시가 사라져 있었고, 어느 프로젝트에 확인할 것이 있었는지는 기억에
 * 의존해야 했다 — 알림의 쓸모가 세션 하나짜리였다.
 *
 * 두 가지를 적는다.
 *
 * 1. 지금 표시가 붙어 있는 세션들. 창을 닫아도 그대로 남는다.
 * 2. 각 세션을 마지막으로 열어 본 시각. 앱이 꺼져 있는 동안 끝난 작업을
 *    잡는 데 쓴다 — 그때는 알려 줄 상대가 없어서 1번이 비어 있다.
 *
 * 서버가 아니라 브라우저에 두는 이유: "내가 봤다"는 사실은 이 기기에서의
 * 사실이다. 폰에서 확인한 것을 노트북에서 안 봤다고 표시하는 편이, 노트북
 * 화면에 한 번도 뜬 적 없는 답을 읽은 것으로 처리하는 것보다 낫다.
 */

const ATTENTION_STORAGE_KEY = 'sessionAttention';
const VIEWED_STORAGE_KEY = 'sessionLastViewed';

/**
 * 열어 본 기록을 들고 있을 세션 수의 상한.
 *
 * 기록은 세션당 한 줄이고 지우는 사람이 없으므로 그냥 두면 무한정 자란다.
 * 오래된 것부터 버린다 — 몇 달 전에 열어 본 대화가 방금 갱신될 일은 드물고,
 * 기록이 없으면 "확인함"으로 보기 때문에 버려도 잘못된 표시가 생기지 않는다.
 */
const MAX_VIEWED_RECORDS = 500;

type ViewedRecords = Record<string, string>;

function readStorage(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 사파리 프라이빗 모드처럼 저장이 막힌 곳에서는 기능만 조용히 빠진다.
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 위와 같다.
  }
}

/** 창을 닫기 전에 붙어 있던 표시. */
export function readPersistedAttentionIds(): string[] {
  const raw = readStorage(ATTENTION_STORAGE_KEY);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** 표시가 바뀔 때마다 통째로 덮어쓴다. 목록이 짧아 비용이 문제되지 않는다. */
export function writePersistedAttentionIds(sessionIds: Iterable<string>): void {
  writeStorage(ATTENTION_STORAGE_KEY, [...sessionIds]);
}

function readViewedRecords(): ViewedRecords {
  const raw = readStorage(VIEWED_STORAGE_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const records: ViewedRecords = {};
  for (const [sessionId, viewedAt] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof viewedAt === 'string' && viewedAt) {
      records[sessionId] = viewedAt;
    }
  }
  return records;
}

/**
 * 이 세션을 방금 확인했다고 적는다.
 *
 * 세션을 열 때와 표시를 지울 때 함께 불린다. 적어 둔 시각보다 대화가 더
 * 최근에 갱신됐으면, 다음에 앱을 열었을 때 표시가 다시 붙는다.
 */
export function recordSessionViewed(sessionId: string, viewedAt: string = new Date().toISOString()): void {
  if (!sessionId) {
    return;
  }

  const records = readViewedRecords();
  records[sessionId] = viewedAt;

  const entries = Object.entries(records);
  if (entries.length > MAX_VIEWED_RECORDS) {
    entries.sort(([, left], [, right]) => right.localeCompare(left));
    writeStorage(VIEWED_STORAGE_KEY, Object.fromEntries(entries.slice(0, MAX_VIEWED_RECORDS)));
    return;
  }

  writeStorage(VIEWED_STORAGE_KEY, records);
}

/**
 * 시각 문자열을 밀리초로. 읽을 수 없으면 `null`.
 *
 * 문자열끼리 비교하지 않는다 — 서버는 대부분 ISO(`...Z`) 를 내려주지만 옛
 * 행에는 SQLite 의 `YYYY-MM-DD HH:MM:SS` 가 남아 있고, 그 둘을 사전순으로
 * 비교하면 조용히 틀린 답이 나온다.
 */
function parseTimestamp(value: string): number | null {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

/** 세션이 마지막으로 움직인 시각. 서버가 내려주는 이름이 여럿이라 순서대로 본다. */
function readSessionActivityAt(session: ProjectSession): string | null {
  const candidates = [session.updated_at, session.lastActivity, session.createdAt, session.created_at];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      return candidate;
    }
  }
  return null;
}

/**
 * 앱이 꺼져 있는 동안 갱신된, 아직 확인하지 않은 대화들.
 *
 * 한 번도 열어 본 적 없는 대화는 제외한다. 포함하면 이 기능을 켠 첫날 사이드바
 * 전체에 점이 찍히고, 그 순간 이 표시는 아무 의미도 없어진다. 열어 본 적이
 * 있다는 것은 "이 대화의 결과를 기다린다"는 뜻이기도 하다.
 *
 * 텔레그램으로 넘겨 돌린 작업이나 예약 메시지처럼, 브라우저가 떠 있지 않은
 * 동안 끝난 턴이 여기서 잡힌다.
 */
export function findUnseenSessionIds(projects: readonly Project[]): string[] {
  const records = readViewedRecords();
  if (Object.keys(records).length === 0) {
    return [];
  }

  const unseen: string[] = [];
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      const viewedAt = records[session.id];
      if (!viewedAt) {
        continue;
      }

      const activityAt = readSessionActivityAt(session);
      const activityTime = activityAt ? parseTimestamp(activityAt) : null;
      const viewedTime = parseTimestamp(viewedAt);
      if (activityTime !== null && viewedTime !== null && activityTime > viewedTime) {
        unseen.push(session.id);
      }
    }
  }
  return unseen;
}
