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
  /** 1 이면 리더가 일을 나눠 맡기고 맡은 참가자들이 동시에 일한다. */
  split_work: number;
  /** 1 이면 답마다 나머지 참가자가 짧게 의견을 낸다. */
  discussion: number;
  created_at: string;
  updated_at: string;
};

/**
 * 참가자가 룸에서 어떤 상태인지.
 *
 * - `active`: 상주. 차례가 돌아오고 의견에도 낀다. 호스트는 늘 이것이다.
 * - `standby`: 명단에만 있다. `@이름` 으로 불러야 온다. 세션이 아직 없을 수 있다.
 * - `summoned`: 불려 와 지금 일하는 중. 차례를 마치면 `standby` 로 돌아간다.
 */
export type RoomParticipantStatus = 'active' | 'standby' | 'summoned';

export type RoomParticipantRow = {
  participant_id: string;
  room_id: string;
  /** 아직 한 번도 불리지 않은 명단 멤버는 NULL 이다. 처음 불릴 때 세션이 생긴다. */
  session_id: string | null;
  provider: string;
  model: string | null;
  display_name: string;
  role_name: string;
  role_prompt: string;
  /** 말투와 태도. 역할과 따로 두어 같은 역할도 다르게 말하게 한다. */
  persona: string;
  /** 1 이면 역할이 바뀐 뒤 아직 본인에게 알리지 않았다. 다음 차례에 다시 안내한다. */
  role_dirty: number;
  status: RoomParticipantStatus;
  position: number;
  last_seen_message_id: number;
  /** 참가자 혼자만 다르게 둔 권한. NULL 이면 룸 설정을 따른다. */
  permission_mode: string | null;
  joined_at: string;
  /** 퇴장한 시각. NULL 이면 아직 룸에 있다. */
  left_at: string | null;
};

/** 새로 넣을 때 정하는 칸. 나머지는 기본값으로 시작한다. */
type NewRoomParticipantRow = Omit<
  RoomParticipantRow,
  'last_seen_message_id' | 'permission_mode' | 'joined_at' | 'left_at' | 'role_dirty'
>;

export type RoomMessageRow = {
  id: number;
  room_id: string;
  speaker: string;
  text: string;
  status: string;
  session_id: string | null;
  /** 첨부 파일 설명의 JSON 배열. 없으면 NULL. */
  attachments: string | null;
  /** 참가자 답의 마지막 말. 사용자 글이나 예전 행은 NULL. */
  final_text: string | null;
  /** `done` | `pass` | `mention:<participant_id>`. 없으면 NULL. */
  handoff: string | null;
  /** reply | plan | task | comment | summary. 사용자 글과 예전 행은 NULL. */
  turn_kind: string | null;
  /** 맡은 일의 JSON(`{"text","canEdit"}`). task 답에만 있다. */
  task: string | null;
  created_at: string;
};

const PARTICIPANT_COLUMNS = `participant_id, room_id, session_id, provider, model, display_name,
  role_name, role_prompt, persona, role_dirty, status, position, last_seen_message_id, permission_mode,
  joined_at, left_at`;

export const roomsDb = {
  /**
   * 대화를 룸으로 바꾸면서 첫 두 참가자(원래 세션과 처음 초대한 참가자)를
   * 한 번에 넣는다. 중간에 실패하면 아무것도 남지 않는다.
   */
  createRoom(
    room: { roomId: string; hostSessionId: string; projectPath: string; permissionMode: string; maxAutoTurns: number },
    participants: Array<Omit<NewRoomParticipantRow, 'room_id'>>,
  ): void {
    const db = getConnection();
    const insertRoom = db.prepare(
      `INSERT INTO rooms (room_id, host_session_id, project_path, permission_mode, max_auto_turns)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertParticipant = db.prepare(
      `INSERT INTO room_participants
         (participant_id, room_id, session_id, provider, model, display_name, role_name, role_prompt, persona, status, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          participant.persona,
          participant.status,
          participant.position,
        );
      }
    })();
  },

  addParticipant(participant: NewRoomParticipantRow): void {
    getConnection()
      .prepare(
        `INSERT INTO room_participants
           (participant_id, room_id, session_id, provider, model, display_name, role_name, role_prompt, persona, status, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        participant.persona,
        participant.status,
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

  /**
   * 이 세션이 어느 룸의 참가자인지. 원래 세션도 참가자로 들어 있으므로 같이 잡힌다.
   * 퇴장한 세션은 다시 평범한 대화이므로 잡지 않는다.
   */
  getParticipantBySession(sessionId: string): RoomParticipantRow | null {
    return (getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants WHERE session_id = ? AND left_at IS NULL LIMIT 1`)
      .get(sessionId) as RoomParticipantRow | undefined) ?? null;
  },

  listRooms(): RoomRow[] {
    return getConnection()
      .prepare('SELECT * FROM rooms ORDER BY created_at, room_id')
      .all() as RoomRow[];
  },

  /** 지금 룸에 있는 참가자. 퇴장한 참가자는 빠진다. */
  listParticipants(roomId: string): RoomParticipantRow[] {
    return getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants WHERE room_id = ? AND left_at IS NULL ORDER BY position`)
      .all(roomId) as RoomParticipantRow[];
  },

  /** 퇴장한 참가자. 타임라인의 지난 발언에 이름을 붙이는 데만 쓴다. */
  listFormerParticipants(roomId: string): RoomParticipantRow[] {
    return getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants WHERE room_id = ? AND left_at IS NOT NULL ORDER BY position`)
      .all(roomId) as RoomParticipantRow[];
  },

  listAllParticipants(): RoomParticipantRow[] {
    return getConnection()
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM room_participants WHERE left_at IS NULL ORDER BY room_id, position`)
      .all() as RoomParticipantRow[];
  },

  updateParticipantPermission(participantId: string, permissionMode: string): void {
    getConnection()
      .prepare('UPDATE room_participants SET permission_mode = ? WHERE participant_id = ?')
      .run(permissionMode, participantId);
  },

  /**
   * 참가자의 이름·역할·역할 지시·성향을 고친다. 준 칸만 바뀐다.
   *
   * `markRoleChanged` 를 주면 `role_dirty` 를 세운다. 참가자 세션은 첫 차례에
   * 받은 역할 안내를 기억할 뿐이라, 이 표시가 있어야 다음 차례에 바뀐 역할을
   * 다시 알려 줄 수 있다.
   */
  updateParticipantProfile(
    participantId: string,
    profile: { displayName?: string; roleName?: string; rolePrompt?: string; persona?: string },
    markRoleChanged: boolean,
  ): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: string | undefined) => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    push('display_name', profile.displayName);
    push('role_name', profile.roleName);
    push('role_prompt', profile.rolePrompt);
    push('persona', profile.persona);
    if (markRoleChanged) {
      assignments.push('role_dirty = 1');
    }
    if (assignments.length === 0) {
      return;
    }
    getConnection()
      .prepare(`UPDATE room_participants SET ${assignments.join(', ')} WHERE participant_id = ?`)
      .run(...values, participantId);
  },

  /**
   * 참가자별로 따로 둔 권한을 모두 지운다. 그러면 전원이 룸 권한을 따른다 —
   * 룸 권한을 바꿀 때 함께 불러, 한 명만 다른 권한으로 남는 일이 없게 한다.
   */
  clearParticipantPermissions(roomId: string): void {
    getConnection()
      .prepare('UPDATE room_participants SET permission_mode = NULL WHERE room_id = ?')
      .run(roomId);
  },

  /**
   * 명단 멤버를 불러오거나 대기로 돌려보낸다.
   *
   * 처음 불릴 때는 그 자리에서 만든 세션을 함께 적는다. 두 번째부터는 세션이
   * 이미 있으므로 상태만 바뀌고, 그 세션이 지난 대화를 그대로 기억한다.
   */
  setParticipantStatus(participantId: string, status: RoomParticipantStatus, sessionId?: string): void {
    const db = getConnection();
    if (sessionId) {
      db.prepare('UPDATE room_participants SET status = ?, session_id = ? WHERE participant_id = ?')
        .run(status, sessionId, participantId);
      return;
    }
    db.prepare('UPDATE room_participants SET status = ? WHERE participant_id = ?').run(status, participantId);
  },

  /** 불려 와 일하던 멤버를 모두 대기로 돌려보낸다. 라운드가 끝날 때 부른다. */
  returnSummonedToStandby(roomId: string): void {
    getConnection()
      .prepare("UPDATE room_participants SET status = 'standby' WHERE room_id = ? AND status = 'summoned'")
      .run(roomId);
  },

  /** 바뀐 역할을 알려 준 뒤 표시를 내린다. */
  clearParticipantRoleDirty(participantId: string): void {
    getConnection()
      .prepare('UPDATE room_participants SET role_dirty = 0 WHERE participant_id = ?')
      .run(participantId);
  },

  /**
   * 명단에서 아주 뺀다. 한 번도 불린 적 없어 세션도 발언도 없는 멤버에만 쓴다 —
   * 행을 지우면 그 이름을 다시 쓸 수 있다.
   */
  deleteParticipant(roomId: string, participantId: string): void {
    getConnection()
      .prepare('DELETE FROM room_participants WHERE participant_id = ? AND room_id = ?')
      .run(participantId, roomId);
    this.touchRoom(roomId);
  },

  markParticipantLeft(roomId: string, participantId: string): void {
    getConnection()
      .prepare('UPDATE room_participants SET left_at = CURRENT_TIMESTAMP WHERE participant_id = ? AND room_id = ?')
      .run(participantId, roomId);
    this.touchRoom(roomId);
  },

  updateRoomSettings(
    roomId: string,
    settings: {
      permissionMode?: string;
      maxAutoTurns?: number;
      splitWork?: boolean;
      discussion?: boolean;
    },
  ): void {
    const db = getConnection();
    if (settings.splitWork !== undefined) {
      db.prepare('UPDATE rooms SET split_work = ? WHERE room_id = ?').run(settings.splitWork ? 1 : 0, roomId);
    }
    if (settings.discussion !== undefined) {
      db.prepare('UPDATE rooms SET discussion = ? WHERE room_id = ?').run(settings.discussion ? 1 : 0, roomId);
    }
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

  insertMessage(message: {
    roomId: string;
    speaker: string;
    text: string;
    status: string;
    sessionId: string | null;
    attachments?: string | null;
    finalText?: string | null;
    handoff?: string | null;
    turnKind?: string | null;
    task?: string | null;
  }): RoomMessageRow {
    const db = getConnection();
    const result = db
      .prepare(
        `INSERT INTO room_messages
           (room_id, speaker, text, status, session_id, attachments, final_text, handoff, turn_kind, task)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.roomId,
        message.speaker,
        message.text,
        message.status,
        message.sessionId,
        message.attachments ?? null,
        message.finalText ?? null,
        message.handoff ?? null,
        message.turnKind ?? null,
        message.task ?? null,
      );
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
