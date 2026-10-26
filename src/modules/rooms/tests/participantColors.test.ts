import { describe, expect, it } from 'vitest';

import { participantColor } from '@/modules/rooms/ParticipantBadge';
import { ROOM_MAX_PARTICIPANTS } from '@/shared/constants';
import type { RoomParticipant } from '@/shared/types';

/**
 * 참가자 색은 자리 번호로 고른다. 색이 참가자보다 적으면 번호가 한 바퀴 돌아
 * 두 사람이 같은 색을 쓰고, 그러면 칩·답변 카드·입력창 멘션 어디서도 둘을
 * 구별할 수 없다.
 */

const at = (position: number) => ({ position } as RoomParticipant);

describe('participant colours', () => {
  it('gives every seat in a full room its own colour', () => {
    const used = new Set(
      Array.from({ length: ROOM_MAX_PARTICIPANTS }, (_, position) => participantColor(at(position)).dot),
    );
    expect(used.size).toBe(ROOM_MAX_PARTICIPANTS);
  });

  it('keeps neighbouring seats apart, since their chips sit side by side', () => {
    for (let position = 0; position < ROOM_MAX_PARTICIPANTS - 1; position += 1) {
      expect(participantColor(at(position)).dot).not.toBe(participantColor(at(position + 1)).dot);
    }
  });

  it('falls back to the first colour for an unknown participant', () => {
    expect(participantColor(undefined).dot).toBe(participantColor(at(0)).dot);
  });
});
