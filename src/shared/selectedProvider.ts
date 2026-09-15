import type { LLMProvider } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { ALL_PROVIDERS, readEnabledProviders } from '@/shared/providerVisibility';

/**
 * The provider the user last chose, shared by chat, the shell, the git panel and
 * the project workspace.
 *
 * It was read from localStorage in six places with four different hand-rolled
 * readers — only one of which validated the stored string — and written from
 * three modules. Nothing published a same-tab change, so the git panel's reader
 * (which listens only for the cross-tab `storage` event) never saw a switch made
 * in its own tab.
 *
 * The value now lives in `auth.db` through the preference store, which notifies
 * its subscribers synchronously — including in the tab that wrote — so the
 * choice both reaches every reader at once and follows the user between devices.
 */

const DEFAULT_PROVIDER: LLMProvider = 'claude';

/**
 * 저장된 선택값이 지금 켜져 있는 provider 가 아니면 켜져 있는 것 중 하나를 돌려준다.
 *
 * 저장값 자체는 건드리지 않는다. 설정에서 provider 를 잠깐 껐다가 다시 켜면 원래
 * 고르고 있던 것으로 그대로 돌아와야 하는데, 읽는 김에 대체값을 써 버리면 그 선택이
 * 영영 사라진다. 반대로 꺼 둔 provider 로 채팅이 열려서도 안 되므로 "저장은 남기되
 * 읽을 때만 가린다" 로 두 요구를 모두 만족시킨다.
 *
 * 대체값은 claude 가 켜져 있으면 claude, 아니면 켜져 있는 것 중 첫 번째다.
 * `readEnabledProviders()` 는 항상 하나 이상을 돌려주므로 빈 목록은 나오지 않는다.
 */
export function readSelectedProvider(): LLMProvider {
  const stored = readUserPreference<string | null>('selectedProvider', null);
  const enabled = readEnabledProviders();

  if (enabled.includes(stored as LLMProvider)) {
    return stored as LLMProvider;
  }

  return enabled.includes(DEFAULT_PROVIDER) ? DEFAULT_PROVIDER : (enabled[0] ?? DEFAULT_PROVIDER);
}

export function writeSelectedProvider(provider: LLMProvider): void {
  // 꺼 둔 provider 라도 저장은 허용한다 — 열려 있던 세션을 이어받아 기록하는
  // 경로가 있고, 다시 켰을 때 그 선택이 살아 있어야 한다. 아예 모르는 이름만 막는다.
  if (!ALL_PROVIDERS.includes(provider)) {
    return;
  }

  writeUserPreference('selectedProvider', provider);
}
