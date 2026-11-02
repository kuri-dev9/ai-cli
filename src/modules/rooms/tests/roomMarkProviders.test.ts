import { describe, expect, it } from 'vitest';

import { pickRoomMarkProviders } from '@/modules/rooms/RoomSessionBadge';

const members = (...providers: string[]) => providers.map((provider) => ({ provider }));

describe('pickRoomMarkProviders', () => {
  it('shows at most two logos, folding the same provider together', () => {
    expect(pickRoomMarkProviders(members('claude', 'claude', 'claude', 'claude', 'claude'))).toEqual(['claude', 'claude']);
    expect(pickRoomMarkProviders(members('codex', 'codex'))).toEqual(['codex', 'codex']);
    expect(pickRoomMarkProviders(members('claude', 'claude', 'codex', 'claude'))).toEqual(['claude', 'codex']);
    expect(pickRoomMarkProviders(members('codex', 'claude', 'cursor'))).toEqual(['codex', 'claude']);
  });

  it('keeps a single logo for a room with one member', () => {
    expect(pickRoomMarkProviders(members('claude'))).toEqual(['claude']);
  });
});
