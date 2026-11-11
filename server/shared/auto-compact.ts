/**
 * 자동 대화 줄이기(`/compact`)를 언제 돌릴지 정하는 규칙.
 *
 * 일반 채팅 세션과 룸 참가자 세션이 같은 규칙을 쓴다. 기준은 두 가지이고, 둘 중
 * 먼저 걸리는 쪽에서 줄인다.
 *
 * - `everyTurns`: 지난번에 줄인 뒤로 이만큼 턴이 쌓이면. 0 이면 이 기준은 끈다.
 * - `tokens`: 세션 맥락에 이만큼 토큰이 차 있으면. 0 이면 `fallbackRatio` 를
 *   쓰고, 그것도 없으면 이 기준은 끈다.
 */

/** 지난 대화를 요약해 맥락을 줄이는 명령. Claude 와 Codex 가 같은 이름을 쓴다. */
export const COMPACT_COMMAND = '/compact';

/** `/compact` 또는 `/compact 요약 지시` 처럼 줄이기를 시키는 글인지. */
export function isCompactCommand(content: string): boolean {
  return /^\/compact(\s|$)/u.test(content.trim());
}

/** `/compact` 를 알아듣는 프로바이더. 나머지는 줄일 방법이 없어 자동 압축에서 빠진다. */
export const COMPACTABLE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** 설정할 수 있는 상한. 화면의 슬라이더도 같은 값을 쓴다. */
export const AUTO_COMPACT_MAX_EVERY_TURNS = 50;
export const AUTO_COMPACT_MAX_TOKENS = 1_000_000;

export type AutoCompactPolicy = {
  everyTurns: number;
  tokens: number;
  /** `tokens` 가 0 일 때 대신 쓰는 맥락 창 비율. 룸이 예전 기본값(60%)을 지키려고 쓴다. */
  fallbackRatio?: number;
};

export type AutoCompactReason = 'turns' | 'tokens';

/** 0 이상 `max` 이하의 정수가 아니면 `null`. 라우트가 400 으로 돌려보낸다. */
export function parseAutoCompactSetting(value: unknown, max: number): number | null {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    return null;
  }
  return parsed;
}

/** 이 정책이 사용량을 읽어야 판정할 수 있는지. 아니면 사용량 조회를 건너뛴다. */
export function autoCompactNeedsUsage(policy: AutoCompactPolicy): boolean {
  return policy.tokens > 0 || Boolean(policy.fallbackRatio);
}

/**
 * 지금 줄여야 하면 그 이유를, 아니면 `null` 을 돌려준다. 사용량을 모르면
 * 토큰 기준은 걸리지 않은 것으로 본다 — 압축은 살림이지 턴의 조건이 아니다.
 */
export function decideAutoCompact(
  policy: AutoCompactPolicy,
  state: {
    turnsSinceCompact: number;
    /**
     * 줄인 뒤 아직 한 턴도 돌지 않았다. Claude 트랜스크립트는 `/compact` 뒤에 새
     * 사용량을 남기지 않아 다음 턴 전까지는 줄이기 전 값이 읽힌다. 그 값으로 다시
     * 줄이면 방금 줄인 세션을 연달아 또 줄이게 된다.
     */
    awaitingTurnAfterCompact?: boolean;
    used?: number | null;
    total?: number | null;
  },
): AutoCompactReason | null {
  if (state.awaitingTurnAfterCompact) {
    return null;
  }
  if (policy.everyTurns > 0 && state.turnsSinceCompact >= policy.everyTurns) {
    return 'turns';
  }
  const used = Number(state.used ?? 0);
  const total = Number(state.total ?? 0);
  if (!(used > 0)) {
    return null;
  }
  if (policy.tokens > 0) {
    return used >= policy.tokens ? 'tokens' : null;
  }
  if (policy.fallbackRatio && total > 0 && used / total >= policy.fallbackRatio) {
    return 'tokens';
  }
  return null;
}
