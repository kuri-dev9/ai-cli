/**
 * The host conversation as it stood before it became a room. Everything the
 * host session says after that is a room turn, which the room timeline already
 * shows, so the earlier part is the only piece the room view is missing.
 */

import type { NormalizedMessage } from '@/shared/types';

/**
 * Reads a room timestamp. The server stores SQLite's UTC `YYYY-MM-DD HH:MM:SS`,
 * which `Date.parse` would take as local time, so it is pinned to UTC here.
 */
export function parseRoomTimestamp(value: string): number {
  const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(isoLike);
}

/**
 * Keeps the host transcript rows written before the room was created. Rows
 * without a readable time are kept too: dropping them could hide part of the
 * original conversation, which is the one thing this view exists to show.
 */
export function selectPreRoomMessages(messages: NormalizedMessage[], roomCreatedAt: string): NormalizedMessage[] {
  const cutoff = parseRoomTimestamp(roomCreatedAt);
  if (!Number.isFinite(cutoff)) {
    return messages;
  }
  return messages.filter((message) => {
    const at = Date.parse(message.timestamp);
    return !Number.isFinite(at) || at < cutoff;
  });
}
