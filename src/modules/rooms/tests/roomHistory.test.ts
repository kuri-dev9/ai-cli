import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { parseRoomTimestamp, selectPreRoomMessages } from '@/modules/rooms/utils/roomHistory';

const message = (id: string, timestamp: string) => ({ id, timestamp, kind: 'text' }) as NormalizedMessage;

describe('room history', () => {
  it('reads SQLite timestamps as UTC', () => {
    expect(parseRoomTimestamp('2026-10-25 04:47:29')).toBe(Date.parse('2026-10-25T04:47:29Z'));
    expect(parseRoomTimestamp('2026-10-25T04:47:29.000Z')).toBe(Date.parse('2026-10-25T04:47:29Z'));
  });

  it('keeps only what the host said before the room was created', () => {
    const messages = [
      message('before', '2026-10-25T04:40:00.000Z'),
      message('at', '2026-10-25T04:47:29.000Z'),
      message('after', '2026-10-25T04:47:48.000Z'),
    ];
    expect(selectPreRoomMessages(messages, '2026-10-25 04:47:29').map((m) => m.id)).toEqual(['before']);
  });

  it('keeps rows whose time cannot be read, and everything when the room time cannot be read', () => {
    const messages = [message('untimed', ''), message('after', '2026-10-25T05:00:00.000Z')];
    expect(selectPreRoomMessages(messages, '2026-10-25 04:47:29').map((m) => m.id)).toEqual(['untimed']);
    expect(selectPreRoomMessages(messages, 'not a time')).toHaveLength(2);
  });
});
