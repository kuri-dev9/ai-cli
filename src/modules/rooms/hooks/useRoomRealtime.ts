import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { RoomMessage, RoomRuntimeState, ServerEvent } from '@/shared/types';
import type { RoomViewAction } from '@/modules/rooms/utils/roomTimelineReducer';

type UseRoomRealtimeArgs = {
  roomId: string | null;
  /** Session of the participant currently running, whose stream is attached. */
  liveSessionId: string | null;
  /** Highest live `seq` already applied, sent as `lastSeq` on (re)subscribe. */
  liveLastSeq: number;
  dispatch: Dispatch<RoomViewAction>;
  reload: () => void;
};

/**
 * Feeds the room view from the shared chat websocket: room frames filtered by
 * roomId, plus the running participant's normal session frames, which this
 * hook attaches with `chat.subscribe` whenever the speaker changes.
 */
export function useRoomRealtime({ roomId, liveSessionId, liveLastSeq, dispatch, reload }: UseRoomRealtimeArgs) {
  const { subscribe, sendMessage } = useWebSocket();
  // Read inside the socket listener and the reconnect path without
  // re-registering the listener on every streamed frame.
  const liveLastSeqRef = useRef(liveLastSeq);
  const liveSessionIdRef = useRef(liveSessionId);
  const reloadRef = useRef(reload);
  // Declared before the subscribe effect so the refs are current when it runs.
  useLayoutEffect(() => {
    liveLastSeqRef.current = liveLastSeq;
    liveSessionIdRef.current = liveSessionId;
    reloadRef.current = reload;
  });

  // Attach to the new speaker's run. Its events only reach this socket once
  // subscribed; the ack also replays anything already emitted this turn.
  useEffect(() => {
    if (!liveSessionId) {
      return;
    }
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{ sessionId: liveSessionId, lastSeq: liveLastSeqRef.current }],
    });
  }, [liveSessionId, sendMessage]);

  useEffect(() => {
    if (!roomId) {
      return undefined;
    }

    return subscribe((event: ServerEvent) => {
      switch (event.kind) {
        case 'room_message':
          if (event.roomId === roomId && event.message) {
            dispatch({ type: 'room_message', message: event.message as RoomMessage });
          }
          return;
        case 'room_state':
          if (event.roomId === roomId && event.state) {
            dispatch({ type: 'room_state', state: event.state as RoomRuntimeState });
          }
          return;
        case 'room_updated':
          if (event.roomId === roomId) {
            reloadRef.current();
          }
          return;
        case 'websocket_reconnected': {
          reloadRef.current();
          const sessionId = liveSessionIdRef.current;
          if (sessionId) {
            sendMessage({
              type: 'chat.subscribe',
              sessions: [{ sessionId, lastSeq: liveLastSeqRef.current }],
            });
          }
          return;
        }
        default:
          break;
      }

      // The reducer keeps only frames of the live session; filtering there
      // (not against a ref here) means no frame is lost in the gap between a
      // speaker change being dispatched and React committing it.
      if (event.sessionId) {
        dispatch({ type: 'live_frame', event });
      }
    });
  }, [dispatch, roomId, sendMessage, subscribe]);
}
