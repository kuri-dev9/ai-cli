import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { RoomDetail, RoomMessage, RoomPermissionMode, RoomRuntimeState } from '@/shared/types';
import {
  INITIAL_ROOM_VIEW_STATE,
  roomViewReducer,
} from '@/modules/rooms/utils/roomTimelineReducer';
import { useRoomRealtime } from '@/modules/rooms/hooks/useRoomRealtime';

type PermissionDecision = { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown };

/**
 * Loads the room hosted by `hostSessionId` and keeps it live: persisted
 * timeline, runtime state, the running participant's stream and its
 * permission prompts, plus the actions the room view can take.
 */
export function useRoom(hostSessionId: string) {
  const { sendMessage } = useWebSocket();
  const [viewState, dispatch] = useReducer(roomViewReducer, INITIAL_ROOM_VIEW_STATE);
  // Shown in place of the room when the first load fails; later refetch
  // failures keep the last good snapshot on screen instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  const roomId = viewState.detail?.room.roomId ?? null;
  // Lets the stable action callbacks below read the room without re-creating them.
  const roomIdRef = useRef(roomId);
  useLayoutEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  const reload = useCallback(async () => {
    try {
      const knownRoomId = roomIdRef.current;
      const response = knownRoomId ? await api.rooms.get(knownRoomId) : await api.rooms.bySession(hostSessionId);
      const body = await readApiJson<{ data?: RoomDetail | null }>(response);
      if (body.data) {
        dispatch({ type: 'detail_loaded', detail: body.data });
        setLoadError(null);
      } else if (!knownRoomId) {
        setLoadError('not_a_room');
      }
    } catch (error) {
      if (!roomIdRef.current) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [hostSessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadInBackground = useCallback(() => {
    void reload();
  }, [reload]);

  useRoomRealtime({
    roomId,
    lives: viewState.lives,
    dispatch,
    reload: reloadInBackground,
  });

  /**
   * Posts a user message. The server queues it for the next turn when a
   * participant is running; a host command runs as written in the host session.
   */
  const postMessage = useCallback(async (message: { content: string; attachments?: unknown[]; hostCommand?: boolean }) => {
    if (!roomIdRef.current) return;
    const response = await api.rooms.postMessage(roomIdRef.current, message);
    const body = await readApiJson<{ data?: { message?: RoomMessage; state?: RoomRuntimeState } }>(response);
    if (body.data?.message) {
      dispatch({ type: 'room_message', message: body.data.message });
    }
    if (body.data?.state) {
      dispatch({ type: 'room_state', state: body.data.state });
    }
  }, []);

  const stop = useCallback(async () => {
    if (!roomIdRef.current) return;
    const response = await api.rooms.stop(roomIdRef.current);
    const body = await readApiJson<{ data?: { state?: RoomRuntimeState } }>(response);
    if (body.data?.state) {
      dispatch({ type: 'room_state', state: body.data.state });
    }
  }, []);

  /** Cuts the running participant off so the waiting user message is handled now. */
  /** 참가자 세션의 맥락을 줄인다. id 를 주지 않으면 세션이 있는 전원이 줄인다. */
  const compact = useCallback(async (participantId?: string) => {
    if (!roomIdRef.current) return;
    const response = await api.rooms.compact(roomIdRef.current, participantId);
    const body = await readApiJson<{ data?: { state?: RoomRuntimeState } }>(response);
    if (body.data?.state) {
      dispatch({ type: 'room_state', state: body.data.state });
    }
  }, []);

  const interrupt = useCallback(async () => {
    if (!roomIdRef.current) return;
    const response = await api.rooms.interrupt(roomIdRef.current);
    const body = await readApiJson<{ data?: { state?: RoomRuntimeState } }>(response);
    if (body.data?.state) {
      dispatch({ type: 'room_state', state: body.data.state });
    }
  }, []);

  const updateParticipant = useCallback(async (
    participantId: string,
    changes: {
      permissionMode?: RoomPermissionMode;
      displayName?: string;
      roleName?: string;
      rolePrompt?: string;
      persona?: string;
    },
  ) => {
    if (!roomIdRef.current) return;
    const response = await api.rooms.updateParticipant(roomIdRef.current, participantId, changes);
    const body = await readApiJson<{ data?: RoomDetail }>(response);
    if (body.data) {
      dispatch({ type: 'detail_loaded', detail: body.data });
    }
  }, []);

  /** Returns the updated room so the caller can refresh the sidebar index too. */
  const removeParticipant = useCallback(async (participantId: string): Promise<RoomDetail | null> => {
    if (!roomIdRef.current) return null;
    const response = await api.rooms.removeParticipant(roomIdRef.current, participantId);
    const body = await readApiJson<{ data?: RoomDetail }>(response);
    if (body.data) {
      dispatch({ type: 'detail_loaded', detail: body.data });
    }
    return body.data ?? null;
  }, []);

  const updateSettings = useCallback(async (changes: {
    maxAutoTurns?: number;
    splitWork?: boolean;
    discussion?: boolean;
    /** 룸 전체 권한. 참가자별로 따로 둔 값은 서버가 함께 지운다. */
    permissionMode?: RoomPermissionMode;
  }) => {
    if (!roomIdRef.current) return;
    const response = await api.rooms.update(roomIdRef.current, changes);
    const body = await readApiJson<{ data?: RoomDetail }>(response);
    if (body.data) {
      dispatch({ type: 'detail_loaded', detail: body.data });
    }
  }, []);

  /** Applies a detail returned by another call (e.g. adding a participant). */
  const applyDetail = useCallback((detail: RoomDetail) => {
    dispatch({ type: 'detail_loaded', detail });
  }, []);

  // Same frame the chat composer sends; the server routes it by requestId.
  const answerPermission = useCallback((requestIds: string | string[], decision: PermissionDecision) => {
    const ids = (Array.isArray(requestIds) ? requestIds : [requestIds]).filter(Boolean);
    if (ids.length === 0) return;
    for (const requestId of ids) {
      sendMessage({
        type: 'chat.permission-response',
        requestId,
        allow: Boolean(decision.allow),
        updatedInput: decision.updatedInput,
        message: decision.message,
        rememberEntry: decision.rememberEntry,
      });
    }
    dispatch({ type: 'permissions_answered', requestIds: ids });
  }, [sendMessage]);

  return {
    detail: viewState.detail,
    lives: viewState.lives,
    pendingPermissions: viewState.pendingPermissions,
    loadError,
    postMessage,
    interrupt,
    stop,
    updateSettings,
    compact,
    updateParticipant,
    removeParticipant,
    applyDetail,
    answerPermission,
  };
}
