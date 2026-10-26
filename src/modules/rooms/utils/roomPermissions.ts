import type { RoomPermissionMode } from '@/shared/types';

/**
 * 권한 고르개가 쓰는 값과 이름표.
 *
 * 룸 전체를 한 번에 바꾸는 머리말의 고르개와, 한 참가자만 다르게 두는 설정
 * 패널의 고르개가 같은 목록을 같은 순서로 보여야 한다.
 */

/** 조심스러운 쪽부터. 고르개에 이 순서로 놓인다. */
export const ROOM_PERMISSION_MODES: RoomPermissionMode[] = ['ask', 'read', 'full'];

export const ROOM_PERMISSION_LABEL_KEYS: Record<RoomPermissionMode, string> = {
  ask: 'rooms.permissionAsk',
  read: 'rooms.permissionRead',
  full: 'rooms.permissionFull',
};
