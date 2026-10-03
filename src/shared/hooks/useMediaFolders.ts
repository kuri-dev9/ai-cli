import { useSyncExternalStore } from 'react';

import { readMediaFolders } from '@/shared/mediaFolders';
import { subscribeToUserPreferences } from '@/shared/userSettings';

/**
 * 플레이어 패널이 훑을 폴더 목록. 설정에서 고치면 즉시 다시 렌더된다.
 *
 * 내용이 같으면 같은 배열을 돌려주므로 `useMemo`·`useEffect` 의존성으로 써도
 * 설정을 저장할 때마다 목록을 다시 읽지 않는다.
 */
export function useMediaFolders(): string[] {
  return useSyncExternalStore(subscribeToUserPreferences, readMediaFolders, readMediaFolders);
}
