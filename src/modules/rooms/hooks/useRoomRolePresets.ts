import { useSyncExternalStore } from 'react';

import { readRoomRolePresets } from '@/modules/rooms/utils/roomRolePresets';
import type { RoomRolePreset } from '@/modules/rooms/utils/roomRolePresets';
import { subscribeToUserPreferences } from '@/shared/userSettings';

/**
 * 역할 프리셋 목록. 관리 화면에서 고치면 초대 창의 칩이 바로 따라 바뀐다.
 * 내용이 같으면 같은 배열을 돌려준다.
 */
export function useRoomRolePresets(): RoomRolePreset[] {
  return useSyncExternalStore(subscribeToUserPreferences, readRoomRolePresets, readRoomRolePresets);
}
