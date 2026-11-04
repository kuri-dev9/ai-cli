import { describe, expect, it } from 'vitest';

import { roomMemberSessionIds } from '@/shared/hooks/useRoomIndex';
import type { RoomIndexEntry } from '@/shared/types';

describe('roomMemberSessionIds', () => {
  it('lists the participant sessions of each room but not the host, which is the room itself', () => {
    const index: RoomIndexEntry[] = [{
      roomId: 'room-1',
      hostSessionId: 'host',
      participants: [
        { participantId: 'p-host', sessionId: 'host', provider: 'claude', displayName: '케이', roleName: '정리자', isHost: true },
        { participantId: 'p-rio', sessionId: 'rio', provider: 'claude', displayName: '리오', roleName: '주입', isHost: false },
        // 한 번도 불리지 않은 명단 멤버는 세션이 없다.
        { participantId: 'p-new', sessionId: null, provider: 'claude', displayName: '새', roleName: '대기', isHost: false },
      ],
    }];
    expect([...roomMemberSessionIds(index)]).toEqual(['rio']);
    expect(roomMemberSessionIds(null).size).toBe(0);
  });
});
