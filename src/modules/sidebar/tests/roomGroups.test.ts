import { describe, expect, it } from 'vitest';

import type { RoomIndexEntry, SessionWithProvider } from '@/shared/types';
import { groupRoomSessions, roomParticipantSessionIds, sessionIdsOfRow } from '@/modules/sidebar/utils/roomGroups';

const session = (id: string): SessionWithProvider => ({ id, __provider: 'claude' });

const room: RoomIndexEntry = {
  roomId: 'room-1',
  hostSessionId: 'host',
  participants: [
    { participantId: 'p-host', sessionId: 'host', provider: 'claude', displayName: '아키', roleName: '설계자', isHost: true },
    { participantId: 'p-codex', sessionId: 'codex', provider: 'codex', displayName: '딴지', roleName: '반대자', isHost: false },
    { participantId: 'p-old', sessionId: 'unloaded', provider: 'claude', displayName: '리뷰', roleName: '리뷰어', isHost: false },
  ],
};

describe('room session grouping', () => {
  it('folds participant sessions under the host row', () => {
    const grouped = groupRoomSessions([session('codex'), session('host'), session('plain')], [room]);

    expect(grouped.sessions.map((s) => s.id)).toEqual(['host', 'plain']);
    const group = grouped.roomsByHostId.get('host');
    expect(group?.members.map((m) => m.participant.sessionId)).toEqual(['codex', 'unloaded']);
    expect(group?.members.map((m) => m.session?.id ?? null)).toEqual(['codex', null]);
  });

  it('leaves participants in place when their host is not in the list', () => {
    const grouped = groupRoomSessions([session('codex'), session('plain')], [room]);

    expect(grouped.sessions.map((s) => s.id)).toEqual(['codex', 'plain']);
    expect(grouped.roomsByHostId.size).toBe(0);
  });

  it('passes the list through while the room index is loading', () => {
    const sessions = [session('codex'), session('host')];
    expect(groupRoomSessions(sessions, null).sessions).toBe(sessions);
  });

  it('lets a room row stand for its members', () => {
    const { roomsByHostId } = groupRoomSessions([session('host')], [room]);
    expect(sessionIdsOfRow('host', roomsByHostId)).toEqual(['host', 'codex', 'unloaded']);
    expect(sessionIdsOfRow('plain', roomsByHostId)).toEqual(['plain']);
  });

  it('lists non-host participants for flat lists', () => {
    expect([...roomParticipantSessionIds([room])]).toEqual(['codex', 'unloaded']);
  });
});
