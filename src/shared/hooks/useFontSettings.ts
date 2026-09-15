import { useCallback, useEffect, useState } from 'react';

import type { FontSettings } from '@/shared/fontSettings';
import { readFontSettings, writeFontSettings } from '@/shared/fontSettings';
import { subscribeToUserPreferences } from '@/shared/userSettings';

const isSameSettings = (a: FontSettings, b: FontSettings): boolean => (
  a.body === b.body && a.heading === b.heading && a.scale === b.scale
);

/**
 * 지금 적용 중인 글꼴 설정과 그것을 바꾸는 함수.
 *
 * 저장소를 렌더 중에 그냥 읽으면 다른 화면(또는 다른 기기)에서 바꾼 값이 이 select 에
 * 반영되지 않는다. 구독 한 번으로 두 경우가 모두 들어온다. 실제로 화면에 글꼴을
 * 입히는 것은 `startFontSettingsSync()` 쪽이라, 이 훅은 UI 상태만 책임진다.
 */
export function useFontSettings(): [FontSettings, (patch: Partial<FontSettings>) => void] {
  const [settings, setSettings] = useState<FontSettings>(readFontSettings);

  useEffect(() => subscribeToUserPreferences(() => {
    setSettings((previous) => {
      const next = readFontSettings();
      return isSameSettings(previous, next) ? previous : next;
    });
  }), []);

  const update = useCallback((patch: Partial<FontSettings>) => {
    setSettings(writeFontSettings(patch));
  }, []);

  return [settings, update];
}
