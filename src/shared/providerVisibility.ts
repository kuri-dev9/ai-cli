import type { LLMProvider } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 화면에 노출할 CLI provider 목록.
 *
 * 이 앱은 claude / cursor / codex / opencode 를 모두 지원하지만, 실제로는 그중
 * 일부만 쓰는 경우가 많다. 안 쓰는 provider 가 온보딩 화면과 모델 선택 목록에
 * 계속 끼어 있으면 방해가 되므로, 설정 > 에이전트 에서 개별로 끄고 켤 수 있다.
 *
 * 이전에는 `.env` 의 `VITE_ENABLED_PROVIDERS` 를 읽었는데, Vite 가 그 값을 빌드
 * 시점에 코드로 박아 넣는 탓에 설정 화면에서 바꿀 수 없었다. 지금은 나머지 사용자
 * 설정과 같이 `auth.db` 에 저장되고(`userSettings`), 구독자에게 동기로 통지되므로
 * 재빌드 없이 즉시 반영되고 기기 사이에서도 따라온다.
 *
 * 저장하는 값은 "켠 목록" 이 아니라 **"끈 목록"** 이다. 켠 목록으로 저장하면 나중에
 * provider 가 하나 추가됐을 때 기존 사용자의 저장값에 그 이름이 없어 자동으로
 * 숨겨진다. 끈 목록이면 기본값이 "전부 켬" 이라 그런 일이 없다.
 *
 * 이건 어디까지나 화면에서 감추는 것이다. 백엔드 API 는 여전히 네 provider 를
 * 모두 받으므로, API 를 직접 호출하면 감춘 것도 동작한다.
 */

/** 백엔드가 지원하는 provider 전체. 화면에 그릴 때의 표준 순서이기도 하다. */
export const ALL_PROVIDERS: readonly LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode'];

/** 사용자 설정에 저장하는 키. */
const PREFERENCE_KEY = 'disabledProviders';

/**
 * 저장된 비활성 목록을 정규화한다: 모르는 이름은 버리고, 중복을 없애고,
 * `ALL_PROVIDERS` 순서로 맞춘다.
 *
 * 네 개가 전부 들어 있으면 통째로 무시한다. UI 는 마지막 하나를 끄지 못하게
 * 막지만, 저장값이 손상됐거나 provider 목록이 줄어든 빌드에서 넘어온 경우까지
 * 앱이 못 쓰게 되는 것보다는 전부 켠 기본 상태로 되돌리는 편이 낫다.
 */
function normalizeDisabled(raw: unknown): LLMProvider[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const disabled = ALL_PROVIDERS.filter((provider) => raw.includes(provider));
  return disabled.length >= ALL_PROVIDERS.length ? [] : disabled;
}

/** 사용자가 꺼 둔 provider 목록. 설정한 적이 없으면 빈 배열(= 전부 켬). */
export function readDisabledProviders(): LLMProvider[] {
  return normalizeDisabled(readUserPreference<unknown>(PREFERENCE_KEY, null));
}

/** 화면에 노출할 provider 목록. 항상 하나 이상이다. */
export function readEnabledProviders(): LLMProvider[] {
  const disabled = readDisabledProviders();
  return ALL_PROVIDERS.filter((provider) => !disabled.includes(provider));
}

export function isProviderEnabled(provider: LLMProvider): boolean {
  return !readDisabledProviders().includes(provider);
}

/**
 * 지금 이 provider 를 끌 수 있는지.
 *
 * 마지막으로 남은 하나까지 끄면 채팅을 시작할 CLI 가 없어져 앱을 못 쓰게 되므로
 * 최소 한 개는 켜 둔 상태를 유지한다.
 */
export function canDisableProvider(provider: LLMProvider): boolean {
  const enabled = readEnabledProviders();
  return !enabled.includes(provider) || enabled.length > 1;
}

/**
 * provider 하나를 켜거나 끈다. 실제로 반영했으면 true.
 *
 * 마지막 하나를 끄려는 요청은 거절한다 — UI 가 그 토글을 비활성화해 두지만,
 * 저장 규칙 자체를 여기서 지켜야 호출하는 쪽이 어디든 안전하다.
 */
export function setProviderEnabled(provider: LLMProvider, enabled: boolean): boolean {
  if (!enabled && !canDisableProvider(provider)) {
    return false;
  }

  const disabled = readDisabledProviders();
  const next = enabled
    ? disabled.filter((entry) => entry !== provider)
    : ALL_PROVIDERS.filter((entry) => entry === provider || disabled.includes(entry));

  writeUserPreference(PREFERENCE_KEY, next);
  return true;
}

/**
 * 어떤 provider 이름인지 정규화한다. 비어 있으면 claude 로 본다 — provider 컬럼이
 * 생기기 전에 만들어진 세션이 그렇다.
 */
export function toProviderName(provider: string | null | undefined): LLMProvider {
  return typeof provider === 'string' && provider.trim()
    ? provider.trim() as LLMProvider
    : 'claude';
}

/**
 * 이 provider 의 것을 목록에 그려도 되는지.
 *
 * 켜 둔 목록을 인자로 받는다. 세션 목록을 거르는 쪽은 모두 React 컴포넌트라
 * `useEnabledProviders()` 로 이미 그 값을 들고 있고, 렌더마다 저장소를 다시 읽는
 * 것보다 넘겨받는 편이 싸다.
 */
export function isVisibleProvider(
  provider: string | null | undefined,
  enabledProviders: readonly LLMProvider[],
): boolean {
  return enabledProviders.includes(toProviderName(provider));
}

/** 네 provider 가 모두 켜져 있는지. 켜져 있으면 거르는 일 자체를 건너뛴다. */
export function hasHiddenProviders(enabledProviders: readonly LLMProvider[]): boolean {
  return enabledProviders.length < ALL_PROVIDERS.length;
}
