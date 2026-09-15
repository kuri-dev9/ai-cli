import { useEffect, useState } from 'react';

import type { LLMProvider } from '@/shared/types';
import { readEnabledProviders } from '@/shared/providerVisibility';
import { subscribeToUserPreferences } from '@/shared/userSettings';

const isSameList = (a: readonly LLMProvider[], b: readonly LLMProvider[]): boolean => (
  a.length === b.length && a.every((provider, index) => provider === b[index])
);

/**
 * 지금 화면에 노출할 provider 목록. 설정에서 끄고 켜면 즉시 다시 렌더된다.
 *
 * 저장소를 렌더 중에 읽으면 설정 화면에서 바꾼 것이 이 화면에 반영되지 않는다.
 * 한 번의 구독으로 이 탭에서 바꾼 것과 서버에서 하이드레이트된 것(= 다른 기기에서
 * 바꾼 것)이 모두 들어온다 — 설정 저장소는 쓴 탭에도 동기로 통지한다.
 *
 * 반환값은 내용이 같으면 같은 배열 인스턴스를 유지한다. 호출하는 쪽이 이 값을
 * `useMemo` 의 의존성으로 쓰는데, 관계없는 설정이 바뀔 때마다 새 배열을 돌려주면
 * 그 메모가 매번 깨진다.
 */
export function useEnabledProviders(): LLMProvider[] {
  const [enabledProviders, setEnabledProviders] = useState<LLMProvider[]>(readEnabledProviders);

  useEffect(() => subscribeToUserPreferences(() => {
    setEnabledProviders((previous) => {
      const next = readEnabledProviders();
      return isSameList(previous, next) ? previous : next;
    });
  }), []);

  return enabledProviders;
}
