import { describe, expect, it } from 'vitest';

import type { RoomIndexEntry, SessionWithProvider } from '@/shared/types';
import {
  groupRoomSessions,
  roomParticipantSessionIds,
  sessionIdsOfRow,
  sessionToOpenForProject,
} from '@/modules/sidebar/utils/roomGroups';

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

describe('session to open when a project is clicked', () => {
  it('opens the latest session when it is an ordinary chat', () => {
    expect(sessionToOpenForProject([session('plain'), session('host')], [room])?.id).toBe('plain');
  });

  it('opens the room (its host session) when the latest session is a participant', () => {
    // 참가자가 가장 최근에 움직였어도 그 개인 세션이 아니라 룸으로 들어간다.
    expect(sessionToOpenForProject([session('codex'), session('plain'), session('host')], [room])?.id).toBe('host');
  });

  it('opens the host session itself, which shows the room', () => {
    expect(sessionToOpenForProject([session('host'), session('codex')], [room])?.id).toBe('host');
  });

  it('keeps a participant whose host is not in the list, as the sidebar does', () => {
    expect(sessionToOpenForProject([session('codex'), session('plain')], [room])?.id).toBe('codex');
  });

  it('falls back to the latest session while the room index is loading', () => {
    expect(sessionToOpenForProject([session('codex'), session('host')], null)?.id).toBe('codex');
  });

  it('opens nothing for a project without sessions', () => {
    expect(sessionToOpenForProject([], [room])).toBeNull();
  });
});
