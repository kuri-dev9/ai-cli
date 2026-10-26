import type { RoomMessageRow, RoomParticipantRow, RoomRow } from '@/modules/database/index.js';
import { normalizeAttachmentDescriptors } from '@/shared/image-attachments.js';
import type { RoomAttachment, RoomMessage, RoomMessageHandoff, RoomParticipant, RoomPermissionMode } from '@/shared/types.js';

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
    permissionMode: parseRoomPermissionMode(row.permission_mode ?? room.permission_mode),
  };
}

/** 저장된 JSON 을 읽는다. 깨진 값은 첨부가 없는 것으로 본다. */
function parseStoredAttachments(value: string | null): RoomAttachment[] {
  if (!value) {
    return [];
  }
  try {
    return normalizeAttachmentDescriptors(JSON.parse(value));
  } catch {
    return [];
  }
}

/** 넘김 표시를 저장할 한 줄로. 표시가 없으면 NULL 이다. */
export function serializeHandoff(handoff: RoomMessageHandoff | null): string | null {
  if (!handoff) return null;
  return handoff.kind === 'mention' ? `mention:${handoff.participantId}` : handoff.kind;
}

function parseStoredHandoff(value: string | null): RoomMessageHandoff | null {
  if (value === 'done' || value === 'pass') return { kind: value };
  if (value?.startsWith('mention:')) return { kind: 'mention', participantId: value.slice('mention:'.length) };
  return null;
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
    attachments: parseStoredAttachments(row.attachments),
    finalText: row.final_text ?? null,
    handoff: parseStoredHandoff(row.handoff ?? null),
    createdAt: row.created_at,
  };
}
