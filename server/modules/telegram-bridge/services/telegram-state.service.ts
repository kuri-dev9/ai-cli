import { userDb, userPreferencesDb } from '@/modules/database/index.js';

/**
 * 브리지가 기억해야 하는 것: 어느 세션에 명령을 넣는지, 어느 세션의 웹 실행까지
 * 알림으로 받을지.
 *
 * 메모리가 아니라 `user_preferences` 에 둔다 — 서버를 재시작했다고 구독이
 * 풀리면, 외출 중에 서버가 한 번 튕긴 뒤로는 아무 알림도 오지 않는데 그 사실을
 * 알 방법이 없다.
 */

const PREFERENCE_KEY = 'telegramBridge';

export type TelegramBridgeState = {
  /**
   * 웹에서 시작한 실행까지 텔레그램으로 중계할 세션들.
   *
   * 여기 없는 세션의 웹 실행은 조용히 끝난다. 텔레그램에서 시작한 실행은 이
   * 목록과 무관하게 항상 회신된다 — 사용자가 폰 앞에서 답을 기다리고 있다.
   */
  notifiedSessionIds: string[];
  /** 명령이 들어가는 세션. `/watch` 로 고른다. */
  watchedSessionId: string | null;
};

/**
 * 기본은 조용하다.
 *
 * 예전 기본값은 "구독 중인 세션의 모든 실행을 알린다"였는데, 그러면 브라우저에서
 * 대화하는 내내 폰이 울린다. 알림은 이제 명시적으로 켠 세션에만 간다. 예전
 * 설정에 남아 있던 `notifications: true` 도 일부러 읽지 않는다 — 켠 적 없는
 * 알림이 업데이트 후에 되살아나는 것이 이 변경이 없애려는 바로 그 소음이다.
 */
const DEFAULT_STATE: TelegramBridgeState = {
  notifiedSessionIds: [],
  watchedSessionId: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

function readSessionIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set(
    value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
  );
  return [...unique];
}

/**
 * 브리지가 대신 행동할 사용자.
 *
 * 이 앱은 사실상 1인용이고, 텔레그램에서 온 명령에는 로그인 세션이 없다.
 * 첫 번째 사용자를 주인으로 본다.
 */
export function readBridgeUserId(): number | null {
  const user = userDb.getFirstUser();
  return user ? Number(user.id) : null;
}

export function readBridgeState(userId: number): TelegramBridgeState {
  const raw = userPreferencesDb.getPreferences(userId)[PREFERENCE_KEY];
  if (!isRecord(raw)) {
    return DEFAULT_STATE;
  }

  return {
    notifiedSessionIds: readSessionIdList(raw.notifiedSessionIds),
    watchedSessionId:
      typeof raw.watchedSessionId === 'string' && raw.watchedSessionId
        ? raw.watchedSessionId
        : null,
  };
}

export function writeBridgeState(userId: number, updates: Partial<TelegramBridgeState>): TelegramBridgeState {
  const next = { ...readBridgeState(userId), ...updates };
  userPreferencesDb.savePreferences(userId, { [PREFERENCE_KEY]: next });
  return next;
}

/** 이 세션의 웹 실행도 텔레그램으로 보내기로 해 뒀는지. */
export function isSessionNotified(userId: number, sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  return readBridgeState(userId).notifiedSessionIds.includes(sessionId);
}

/**
 * 세션 단위 알림 토글. 웹 UI 와 텔레그램의 `/on`·`/off` 가 같은 값을 건드린다.
 *
 * 세션 목록으로 들고 있어서 화면에서 어느 세션을 켜 두든 `/watch` 대상이
 * 바뀌지 않는다 — 텔레그램에서 A 를 보면서 웹에서 B 의 알림을 켜는 것이
 * 자연스러운 조합이고, 둘을 한 값으로 묶으면 한쪽이 다른 쪽을 말없이 끈다.
 */
export function setSessionNotified(
  userId: number,
  sessionId: string,
  enabled: boolean,
): TelegramBridgeState {
  const current = readBridgeState(userId);
  const remaining = current.notifiedSessionIds.filter((entry) => entry !== sessionId);

  return writeBridgeState(userId, {
    notifiedSessionIds: enabled && sessionId ? [...remaining, sessionId] : remaining,
  });
}
