/**
 * 모델 이름에서 컨텍스트 윈도우 크기를 판별한다.
 *
 * `CONTEXT_WINDOW` 환경변수 하나로는 부족하다. 같은 이름의 모델이 200K와 1M
 * 두 가지로 돌 수 있고(`claude-opus-5` vs `claude-opus-5[1m]`), 세션마다 다른
 * 모델을 쓸 수도 있는데 환경변수는 서버 전체에 하나뿐이기 때문이다. 값이
 * 실제보다 작으면 "used 240,756 / window 160,000" 같은 모순이 생겨 잔량을
 * 아예 표시할 수 없게 된다.
 *
 * 그래서 모델 이름을 먼저 보고, 판별하지 못할 때만 환경변수로 내려간다.
 */

/** 판별 실패 시 마지막으로 쓰는 값. `CONTEXT_WINDOW`도 없을 때. */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * used가 판별된 윈도우를 넘었을 때 올라갈 단계.
 *
 * 환경변수가 낡았거나 모르는 모델일 때 "초과" 상태로 굳는 대신, 실제 사용량을
 * 담을 수 있는 가장 가까운 크기로 올린다.
 */
const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000, 2_000_000];

/** 이름으로 윈도우를 특정할 수 있는 모델들. 위에서부터 먼저 맞는 것을 쓴다. */
const MODEL_CONTEXT_WINDOW_RULES: Array<{ pattern: RegExp; window: number }> = [
  // Claude Code가 1M 변형에 붙이는 접미어: `claude-opus-5[1m]`.
  { pattern: /\[1m\]|[-_]1m\b/i, window: 1_000_000 },
  // Haiku 4.5는 현행 Claude 중 유일하게 200K다.
  { pattern: /haiku[-_]?4[-_.]?5/i, window: 200_000 },
  // 1M 세대: Fable/Mythos 5, Opus 5·4.8·4.7·4.6, Sonnet 5·4.6.
  { pattern: /(fable|mythos)[-_]?5/i, window: 1_000_000 },
  { pattern: /opus[-_]?(5|4[-_.]?[678])/i, window: 1_000_000 },
  { pattern: /sonnet[-_]?(5|4[-_.]?6)/i, window: 1_000_000 },
  // 그 이전 세대(Opus 4.5, Sonnet 4.5, Haiku 3.5 …)는 200K.
  { pattern: /claude|opus|sonnet|haiku/i, window: 200_000 },
  // GPT-5 계열(Codex)은 400K. Codex는 자체 이벤트로 윈도우를 보고하므로
  // 여기까지 오는 경우는 드물지만, 오면 0보다는 낫다.
  { pattern: /gpt[-_]?5|codex/i, window: 400_000 },
];

function readPositiveNumber(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 이름으로 판별되는 윈도우. 모르는 모델이면 0. */
export function readModelContextWindow(model: unknown): number {
  if (typeof model !== 'string' || !model.trim()) {
    return 0;
  }

  // `/models`가 아직 아무것도 못 정했을 때 쓰는 값이라 모델 이름이 아니다.
  const normalized = model.trim();
  if (normalized.toLowerCase() === 'default') {
    return 0;
  }

  for (const rule of MODEL_CONTEXT_WINDOW_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.window;
    }
  }
  return 0;
}

/**
 * 사용량을 담지 못하는 윈도우를 한 단계 위로 올린다.
 *
 * used를 이미 담고 있으면 그대로 둔다 — 환경변수로 일부러 작게 잡아둔 값을
 * 임의로 키우지 않기 위해서다.
 */
export function fitContextWindowToUsage(contextWindow: number, used: number): number {
  if (used <= 0 || contextWindow >= used) {
    return contextWindow;
  }
  return CONTEXT_WINDOW_TIERS.find((tier) => tier >= used) ?? used;
}

/**
 * 모델 이름 → 설정값 → 기본값 순으로 컨텍스트 윈도우를 정한다.
 *
 * `used`를 주면 마지막에 사용량을 담을 수 있는 크기까지 올려준다.
 */
export function resolveContextWindow(options: {
  model?: unknown;
  configured?: unknown;
  used?: number;
}): number {
  const used = readPositiveNumber(options.used);
  const resolved =
    readModelContextWindow(options.model)
    || readPositiveNumber(options.configured)
    || FALLBACK_CONTEXT_WINDOW;

  return fitContextWindowToUsage(resolved, used);
}
