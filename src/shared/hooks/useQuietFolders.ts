import { useSyncExternalStore } from 'react';

import type { QuietFoldersState } from '@/shared/quietFolders';
import { readQuietFolders } from '@/shared/quietFolders';
import { subscribeToUserPreferences } from '@/shared/userSettings';

/**
 * 조용히 둘 폴더 목록. 설정에서 고치면 즉시 다시 렌더된다.
 *
 * sidebar 는 프로젝트를 맨 아래 묶음으로 옮기는 데, project-workspace 는 그
 * 아래 세션에 점을 찍지 않는 데, settings 는 목록을 고치는 화면에 쓴다.
 * 내용이 같으면 같은 객체를 돌려주므로 `useMemo` 의존성으로 써도 된다.
 */
export function useQuietFolders(): QuietFoldersState {
  return useSyncExternalStore(subscribeToUserPreferences, readQuietFolders, readQuietFolders);
}
