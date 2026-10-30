import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Dispatch } from 'react';

import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { RoomMessage, RoomRuntimeState, ServerEvent } from '@/shared/types';
import type { RoomLiveBuffer, RoomViewAction } from '@/modules/rooms/utils/roomTimelineReducer';

type UseRoomRealtimeArgs = {
  roomId: string | null;
  /** Streams of the participants running now, whose sessions get attached. */
  lives: RoomLiveBuffer[];
  /** Whether a turn is running; only then is a silent socket suspicious. */
  isRunning: boolean;
  dispatch: Dispatch<RoomViewAction>;
  reload: () => void;
};

/** `chat.subscribe` entries for these streams, each resuming after the last `seq` it applied. */
const toSubscriptions = (lives: RoomLiveBuffer[]) =>
  lives.map((buffer) => ({ sessionId: buffer.sessionId, lastSeq: buffer.lastSeq }));

/**
 * 차례가 도는데 이만큼 아무 소식이 없으면 룸을 다시 읽는다. 소켓이 열린 채
 * 소식만 끊기면 화면은 그걸 알 길이 없어 새로고침할 때까지 멈춰 있었다. 긴
 * 명령 하나가 조용히 도는 동안에도 걸리지만, 다시 읽기는 가볍고 결과가 같다.
 */
const SILENT_RESYNC_MS = 30_000;

/**
 * Feeds the room view from the shared chat websocket: room frames filtered by
 * roomId, plus the running participants' normal session frames, which this
 * hook attaches with `chat.subscribe` whenever a participant starts running.
 */
export function useRoomRealtime({ roomId, lives, isRunning, dispatch, reload }: UseRoomRealtimeArgs) {
  const { subscribe, sendMessage } = useWebSocket();
  // Read inside the socket listener and the reconnect path without
  // re-registering the listener on every streamed frame.
  const livesRef = useRef(lives);
  const reloadRef = useRef(reload);
  // Sessions already attached, so a streamed frame does not resubscribe them.
  const subscribedRef = useRef(new Set<string>());
  // When the last frame for this room (or its running sessions) arrived.
  const lastFrameAtRef = useRef(Date.now());
  // Declared before the subscribe effect so the refs are current when it runs.
  useLayoutEffect(() => {
    livesRef.current = lives;
    reloadRef.current = reload;
  });

  // Attach to each newly running session. Its events only reach this socket
  // once subscribed; the ack also replays anything already emitted this turn.
  const liveSessionKey = lives.map((buffer) => buffer.sessionId).join('\n');
  useEffect(() => {
    const running = livesRef.current;
    const fresh = running.filter((buffer) => !subscribedRef.current.has(buffer.sessionId));
    subscribedRef.current = new Set(running.map((buffer) => buffer.sessionId));
    if (fresh.length > 0) {
      sendMessage({ type: 'chat.subscribe', sessions: toSubscriptions(fresh) });
    }
  }, [liveSessionKey, sendMessage]);

  useEffect(() => {
    if (!roomId) {
      return undefined;
    }

    return subscribe((event: ServerEvent) => {
      if ((event.roomId === roomId) || (event.sessionId && livesRef.current.some((buffer) => buffer.sessionId === event.sessionId))) {
        lastFrameAtRef.current = Date.now();
      }
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
          if (livesRef.current.length > 0) {
            sendMessage({ type: 'chat.subscribe', sessions: toSubscriptions(livesRef.current) });
          }
          return;
        }
        default:
          break;
      }

      // The reducer keeps only frames of the live sessions; filtering there
      // (not against a ref here) means no frame is lost in the gap between a
      // speaker change being dispatched and React committing it.
      if (event.sessionId) {
        dispatch({ type: 'live_frame', event });
      }
    });
  }, [dispatch, roomId, sendMessage, subscribe]);

  useEffect(() => {
    if (!roomId || !isRunning) {
      return undefined;
    }
    lastFrameAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - lastFrameAtRef.current < SILENT_RESYNC_MS) {
        return;
      }
      lastFrameAtRef.current = Date.now();
      reloadRef.current();
    }, SILENT_RESYNC_MS / 3);
    return () => window.clearInterval(timer);
  }, [isRunning, roomId]);
}
