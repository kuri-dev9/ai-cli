import type { RoomIndexEntry, SessionWithProvider } from '@/shared/types';

/** A room as the sidebar draws it: the host row plus the participant sessions folded under it. */
export type SidebarRoomGroup = {
  room: RoomIndexEntry;
  /**
   * Non-host participants that have a session, in room order. Roster members
   * waiting to be called have no session yet and nothing to fold, so they are
   * left out. `session` is the loaded row when this page of the list has it.
   */
  members: Array<{
    participant: RoomIndexEntry['participants'][number] & { sessionId: string };
    session: SessionWithProvider | null;
  }>;
};

export type GroupedSessions = {
  /** The list to draw, with participant sessions taken out of it. */
  sessions: SessionWithProvider[];
  /** Rooms keyed by their host session id. */
  roomsByHostId: Map<string, SidebarRoomGroup>;
};

/**
 * Folds room participant sessions under their room's host row, like sessions
 * under a project. A participant is only folded when its host is in the same
 * list: otherwise it would vanish with nothing on screen to reach it through.
 */
export function groupRoomSessions(
  sessions: SessionWithProvider[],
  rooms: RoomIndexEntry[] | null,
): GroupedSessions {
  const roomsByHostId = new Map<string, SidebarRoomGroup>();
  if (!rooms?.length) {
    return { sessions, roomsByHostId };
  }

  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const foldedIds = new Set<string>();
  for (const room of rooms) {
    if (!sessionsById.has(room.hostSessionId)) continue;
    const members = room.participants
      .filter((participant) => participant.sessionId !== null && participant.sessionId !== room.hostSessionId)
      .map((participant) => ({
        participant: participant as RoomIndexEntry['participants'][number] & { sessionId: string },
        session: sessionsById.get(participant.sessionId as string) ?? null,
      }));
    for (const member of members) {
      foldedIds.add(member.participant.sessionId);
    }
    roomsByHostId.set(room.hostSessionId, { room, members });
  }

  return {
    sessions: sessions.filter((session) => !foldedIds.has(session.id)),
    roomsByHostId,
  };
}

/** Session ids a row stands for: itself, plus its folded members when it hosts a room. */
export function sessionIdsOfRow(sessionId: string, roomsByHostId: Map<string, SidebarRoomGroup>): string[] {
  const group = roomsByHostId.get(sessionId);
  return group ? [sessionId, ...group.members.map((member) => member.participant.sessionId)] : [sessionId];
}

/** Session ids that are a non-host room participant, to keep out of flat lists such as recents. */
export function roomParticipantSessionIds(rooms: RoomIndexEntry[] | null): Set<string> {
  const ids = new Set<string>();
  for (const room of rooms ?? []) {
    for (const participant of room.participants) {
      // Roster members have no session, so there is nothing to keep out.
      if (participant.sessionId && participant.sessionId !== room.hostSessionId) {
        ids.add(participant.sessionId);
      }
    }
  }
  return ids;
}

/**
 * 프로젝트를 눌렀을 때 열 세션. 목록 맨 위(가장 최근) 세션이지만, 그것이 방장
 * 행 아래에 묶이는 룸 참가자라면 그 룸의 방장 세션을 연다 — 방장 세션은 룸
 * 화면으로 열린다. 참가자 개인 세션으로 바로 들어가면 룸이 아니라 그 참가자
 * 하나와 대화하게 된다. 묶는 규칙은 groupRoomSessions 와 같다.
 */
export function sessionToOpenForProject(
  sessions: SessionWithProvider[],
  rooms: RoomIndexEntry[] | null,
): SessionWithProvider | null {
  const latest = sessions[0];
  if (!latest) {
    return null;
  }

  for (const room of rooms ?? []) {
    if (room.hostSessionId === latest.id) {
      return latest;
    }
    const isParticipant = room.participants.some((participant) => participant.sessionId === latest.id);
    if (!isParticipant) continue;
    // 방장이 이 목록에 없으면 사이드바도 묶지 않고 참가자 행을 그대로 보여 준다.
    return sessions.find((session) => session.id === room.hostSessionId) ?? latest;
  }

  return latest;
}
