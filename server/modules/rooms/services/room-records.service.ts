import type { RoomMessageRow, RoomParticipantRow, RoomRow } from '@/modules/database/index.js';
import type { RoomMessage, RoomParticipant, RoomPermissionMode } from '@/shared/types.js';

/**
 * 저장된 행을 화면·턴 엔진이 쓰는 모양으로 바꾼다. 룸 서비스와 턴 엔진이 같이
 * 쓰므로 한곳에 둔다.
 */

const ROOM_PERMISSION_MODES: RoomPermissionMode[] = ['ask', 'read', 'full'];

/** 알 수 없는 값은 가장 조심스러운 `ask` 로 읽는다. */
export function parseRoomPermissionMode(value: unknown): RoomPermissionMode {
  return ROOM_PERMISSION_MODES.includes(value as RoomPermissionMode)
    ? (value as RoomPermissionMode)
    : 'ask';
}

export function toRoomParticipant(row: RoomParticipantRow, room: RoomRow): RoomParticipant {
  return {
    participantId: row.participant_id,
    roomId: row.room_id,
    sessionId: row.session_id,
    provider: row.provider,
    model: row.model,
    displayName: row.display_name,
    roleName: row.role_name,
    rolePrompt: row.role_prompt,
    position: row.position,
    isHost: row.session_id === room.host_session_id,
  };
}

export function toRoomMessage(row: RoomMessageRow): RoomMessage {
  const status = row.status === 'aborted' || row.status === 'error' ? row.status : 'complete';
  return {
    id: row.id,
    roomId: row.room_id,
    speaker: row.speaker,
    text: row.text,
    status,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}
