import type { RoomIndexEntry, SessionWithProvider } from '@/shared/types';

/** A room as the sidebar draws it: the host row plus the participant sessions folded under it. */
export type SidebarRoomGroup = {
  room: RoomIndexEntry;
  /** Non-host participants, in room order. `session` is the loaded row when this page of the list has it. */
  members: Array<{
    participant: RoomIndexEntry['participants'][number];
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
      .filter((participant) => participant.sessionId !== room.hostSessionId)
      .map((participant) => ({ participant, session: sessionsById.get(participant.sessionId) ?? null }));
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
      if (participant.sessionId !== room.hostSessionId) {
        ids.add(participant.sessionId);
      }
    }
  }
  return ids;
}
