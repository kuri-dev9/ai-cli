import { getConnection } from '@/modules/database/connection.js';

/**
 * 팀 룸 저장소. 룸, 참가자, 룸 타임라인 세 표를 다룬다.
 *
 * 참가자 하나하나는 실제 앱 세션(`sessions`)이다. 이 표들은 그 세션들을 한
 * 자리에 묶고, 서로 주고받은 말을 순서대로 남기는 일만 한다.
 */

export type RoomRow = {
  room_id: string;
  host_session_id: string;
  project_path: string;
  permission_mode: string;
  max_auto_turns: number;
  created_at: string;
  updated_at: string;
};

export type RoomParticipantRow = {
  participant_id: string;
  room_id: string;
  session_id: string;
  provider: string;
  model: string | null;
  display_name: string;
  role_name: string;
  role_prompt: string;
  position: number;
  last_seen_message_id: number;
  joined_at: string;
};

export type RoomMessageRow = {
  id: number;
  room_id: string;
  speaker: string;
  text: string;
  status: string;
  session_id: string | null;
  created_at: string;
};

const PARTICIPANT_COLUMNS = `participant_id, room_id, session_id, provider, model, display_name,
  role_name, role_prompt, position, last_seen_message_id, joined_at`;

export const roomsDb = {
  /**
   * 대화를 룸으로 바꾸면서 첫 두 참가자(원래 세션과 처음 초대한 참가자)를
   * 한 번에 넣는다. 중간에 실패하면 아무것도 남지 않는다.
   */
  createRoom(
    room: { roomId: string; hostSessionId: string; projectPath: string; permissionMode: string; maxAutoTurns: number },
    participants: Array<Omit<RoomParticipantRow, 'room_id' | 'last_seen_message_id' | 'joined_at'>>,
  ): void {
    const db = getConnection();
    const insertRoom = db.prepare(
      `INSERT INTO rooms (room_id, host_session_id, project_path, permission_mode, max_auto_turns)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertParticipant = db.prepare(
      `INSERT INTO room_participants
         (participant_id, room_id, session_id, provider, model, display_name, role_name, role_prompt, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      insertRoom.run(room.roomId, room.hostSessionId, room.projectPath, room.permissionMode, room.maxAutoTurns);
      for (const participant of participants) {
        insertParticipant.run(
          participant.participant_id,
          room.roomId,
          participant.session_id,
          participant.provider,
          participant.model,
          participant.display_name,
          participant.role_name,
          participant.role_prompt,
          participant.position,
        );
      }
    })();
  },

  addParticipant(participant: Omit<RoomParticipantRow, 'last_seen_message_id' | 'joined_at'>): void {
    getConnection()
      .prepare(
        `INSERT INTO room_participants
           (participant_id, room_id, session_id, provider, model, display_name, role_name, role_prompt, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        participant.participant_id,
        participant.room_id,
        participant.session_id,
        participant.provider,
        participant.model,
        participant.display_name,
        participant.role_name,
        participant.role_prompt,
        participant.position,
      );
    this.touchRoom(participant.room_id);
  },

  getRoom(roomId: string): RoomRow | null {
    return (getConnection()
      .prepare('SELECT * FROM rooms WHERE room_id = ?')
      .get(roomId) as RoomRow | undefined) ?? null;
  },

  getRoomByHostSession(sessionId: string): RoomRow | null {
    return (getConnection()
      .prepare('SELECT * FROM rooms WHERE host_session_id = ?')
      .get(sessionId) as RoomRow | undefined) ?? null;
  },

  /** 이 세션이 어느 룸의 참가자인지. 원래 세션도 참가자로 들어 있으므로 같이 잡힌다. */
  getParticipantBySession(sessionId: string): RoomParticipantRow | null {
    return (getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants WHERE session_id = ? LIMIT 1`)
      .get(sessionId) as RoomParticipantRow | undefined) ?? null;
  },

  listRooms(): RoomRow[] {
    return getConnection()
      .prepare('SELECT * FROM rooms ORDER BY created_at, room_id')
      .all() as RoomRow[];
  },

  listParticipants(roomId: string): RoomParticipantRow[] {
    return getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants WHERE room_id = ? ORDER BY position`)
      .all(roomId) as RoomParticipantRow[];
  },

  listAllParticipants(): RoomParticipantRow[] {
    return getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants ORDER BY room_id, position`)
      .all() as RoomParticipantRow[];
  },

  updateRoomSettings(roomId: string, settings: { permissionMode?: string; maxAutoTurns?: number }): void {
    const db = getConnection();
    if (settings.permissionMode !== undefined) {
      db.prepare('UPDATE rooms SET permission_mode = ? WHERE room_id = ?').run(settings.permissionMode, roomId);
    }
    if (settings.maxAutoTurns !== undefined) {
      db.prepare('UPDATE rooms SET max_auto_turns = ? WHERE room_id = ?').run(settings.maxAutoTurns, roomId);
    }
    this.touchRoom(roomId);
  },

  touchRoom(roomId: string): void {
    getConnection()
      .prepare('UPDATE rooms SET updated_at = CURRENT_TIMESTAMP WHERE room_id = ?')
      .run(roomId);
  },

  markParticipantSeen(participantId: string, messageId: number): void {
    // 뒤로 가지 않는다. 늦게 끝난 턴이 더 최근에 읽은 자리를 덮으면 같은 글을 두 번 보낸다.
    getConnection()
      .prepare(
        `UPDATE room_participants SET last_seen_message_id = ?
          WHERE participant_id = ? AND last_seen_message_id < ?`,
      )
      .run(messageId, participantId, messageId);
  },

  insertMessage(message: { roomId: string; speaker: string; text: string; status: string; sessionId: string | null }): RoomMessageRow {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO room_messages (room_id, speaker, text, status, session_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(message.roomId, message.speaker, message.text, message.status, message.sessionId);
    this.touchRoom(message.roomId);
    return db
      .prepare('SELECT * FROM room_messages WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as RoomMessageRow;
  },

  listMessages(roomId: string): RoomMessageRow[] {
    return getConnection()
      .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY id')
      .all(roomId) as RoomMessageRow[];
  },

  listMessagesAfter(roomId: string, afterId: number): RoomMessageRow[] {
    return getConnection()
      .prepare('SELECT * FROM room_messages WHERE room_id = ? AND id > ? ORDER BY id')
      .all(roomId, afterId) as RoomMessageRow[];
  },
};
