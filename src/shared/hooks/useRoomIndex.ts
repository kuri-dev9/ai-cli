import { useEffect, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { RoomDetail, RoomIndexEntry, ServerEvent } from '@/shared/types';

/*
 * One app-wide copy of `GET /api/rooms`.
 *
 * Every sidebar row and the workspace ask "is this session part of a room?",
 * so the answer lives in a module-level store instead of per-component state:
 * one request serves all of them and a refresh reaches every row at once even
 * though the sidebar rows are memoized.
 */

let roomIndexSnapshot: RoomIndexEntry[] | null = null;
let inFlightRefresh: Promise<void> | null = null;
const roomIndexListeners = new Set<() => void>();

const publishRoomIndex = (next: RoomIndexEntry[]) => {
  roomIndexSnapshot = next;
  for (const listener of roomIndexListeners) {
    listener();
  }
};

const subscribeRoomIndex = (listener: () => void) => {
  roomIndexListeners.add(listener);
  return () => {
    roomIndexListeners.delete(listener);
  };
};

const readRoomIndex = () => roomIndexSnapshot;

/**
 * Refetches the room index. Concurrent callers share one request, so a burst
 * of `room_updated` frames costs a single round trip.
 */
export function refreshRoomIndex(): Promise<void> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  inFlightRefresh = (async () => {
    try {
      const response = await api.rooms.list();
      const body = await readApiJson<{ data?: { rooms?: RoomIndexEntry[] } }>(response);
      publishRoomIndex(Array.isArray(body.data?.rooms) ? body.data.rooms : []);
    } catch (error) {
      // A server without the rooms API simply has no rooms.
      console.warn('[rooms] Failed to load the room index:', error);
      if (roomIndexSnapshot === null) {
        publishRoomIndex([]);
      }
    } finally {
      inFlightRefresh = null;
    }
  })();
  return inFlightRefresh;
}

/**
 * Folds a freshly returned room into the index right away, so the workspace
 * switches to the room view without waiting for the next index refetch.
 */
export function applyRoomDetailToIndex(detail: RoomDetail): void {
  const entry: RoomIndexEntry = {
    roomId: detail.room.roomId,
    hostSessionId: detail.room.hostSessionId,
    participants: detail.participants.map((participant) => ({
      participantId: participant.participantId,
      sessionId: participant.sessionId,
      provider: participant.provider,
      displayName: participant.displayName,
      roleName: participant.roleName,
      isHost: participant.isHost,
    })),
  };
  const current = roomIndexSnapshot ?? [];
  const withoutRoom = current.filter((room) => room.roomId !== entry.roomId);
  publishRoomIndex([...withoutRoom, entry]);
}

/**
 * The whole room index, or null while it is still loading. For callers that
 * reshape a list of sessions at once instead of asking about one session.
 */
export function useRoomIndex(): RoomIndexEntry[] | null {
  const index = useSyncExternalStore(subscribeRoomIndex, readRoomIndex, readRoomIndex);

  useEffect(() => {
    if (roomIndexSnapshot === null) {
      void refreshRoomIndex();
    }
  }, []);

  return index;
}

/**
 * Path that opens a session. A room host session normally opens as the room;
 * `view: 'chat'` opens that same session as its own plain chat instead.
 */
export function sessionPath(sessionId: string, view?: 'chat'): string {
  return view === 'chat' ? `/session/${sessionId}?view=chat` : `/session/${sessionId}`;
}

/** Whether the current URL asks for a session's plain chat rather than its room view. */
export function useIsPlainChatView(): boolean {
  const [searchParams] = useSearchParams();
  return searchParams.get('view') === 'chat';
}

/** A session's place in a room, as resolved from the room index. */
export type RoomMembership = {
  room: RoomIndexEntry;
  participant: RoomIndexEntry['participants'][number] | null;
  isHost: boolean;
};

/**
 * Looks up which room, if any, a session belongs to. Returns null while the
 * index is still loading or when the session is not in a room.
 */
export function useRoomMembership(sessionId: string | null | undefined): RoomMembership | null {
  const index = useRoomIndex();

  if (!sessionId || !index) {
    return null;
  }
  for (const room of index) {
    const participant = room.participants.find((member) => member.sessionId === sessionId) ?? null;
    if (room.hostSessionId === sessionId || participant) {
      return { room, participant, isHost: room.hostSessionId === sessionId };
    }
  }
  return null;
}

/**
 * Keeps the room index current: refetches on `room_updated` and after a
 * websocket reconnect. Mount once, where the workspace lives.
 */
export function useRoomIndexSync(): void {
  const { subscribe } = useWebSocket();

  useEffect(() => subscribe((event: ServerEvent) => {
    if (event.kind === 'room_updated' || event.kind === 'websocket_reconnected') {
      void refreshRoomIndex();
    }
  }), [subscribe]);
}
