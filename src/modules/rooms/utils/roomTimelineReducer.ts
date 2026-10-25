import type {
  LLMProvider,
  NormalizedMessage,
  PendingPermissionRequest,
  RoomDetail,
  RoomMessage,
  RoomRuntimeState,
  ServerEvent,
} from '@/shared/types';

/**
 * The running participant's turn as it streams in. Only one participant runs
 * at a time, so one buffer is enough; it is keyed by session so frames from
 * any other session are ignored.
 */
export type RoomLiveBuffer = {
  sessionId: string | null;
  frames: NormalizedMessage[];
  /** Highest `seq` applied, so a replay after `chat.subscribe` is not drawn twice. */
  lastSeq: number;
};

export type RoomViewState = {
  detail: RoomDetail | null;
  live: RoomLiveBuffer;
  /** Permission prompts raised by the running participant, answered from the room view. */
  pendingPermissions: PendingPermissionRequest[];
};

export type RoomViewAction =
  | { type: 'detail_loaded'; detail: RoomDetail }
  | { type: 'room_message'; message: RoomMessage }
  | { type: 'room_state'; state: RoomRuntimeState }
  | { type: 'live_frame'; event: ServerEvent }
  | { type: 'permissions_answered'; requestIds: string[] };

const EMPTY_LIVE: RoomLiveBuffer = { sessionId: null, frames: [], lastSeq: 0 };

export const INITIAL_ROOM_VIEW_STATE: RoomViewState = {
  detail: null,
  live: EMPTY_LIVE,
  pendingPermissions: [],
};

// Frames that become visible transcript rows. Control frames (status,
// complete, permission_*) drive state instead.
const LIVE_CONTENT_KINDS = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'error', 'task_notification']);

const STREAMING_FRAME_ID = '__room_streaming';

/**
 * The server opens every participant turn by echoing the whole internal
 * prompt (room context plus instructions) as a synthetic user row whose id
 * starts with `local_`. That text is plumbing, not something anyone said.
 */
export function isSyntheticPromptFrame(event: ServerEvent): boolean {
  return event.kind === 'text'
    && event.role === 'user'
    && typeof event.id === 'string'
    && event.id.startsWith('local_');
}

const insertRoomMessage = (messages: RoomMessage[], message: RoomMessage): RoomMessage[] => {
  if (messages.some((existing) => existing.id === message.id)) {
    return messages.map((existing) => (existing.id === message.id ? message : existing));
  }
  return [...messages, message].sort((a, b) => a.id - b.id);
};

const finalizeStreamingFrame = (frames: NormalizedMessage[]): NormalizedMessage[] =>
  frames.map((frame) => (frame.id === STREAMING_FRAME_ID
    ? { ...frame, id: `${STREAMING_FRAME_ID}_${frame.timestamp}`, kind: 'text', role: 'assistant' }
    : frame));

const applyLiveFrame = (state: RoomViewState, event: ServerEvent): RoomViewState => {
  const { live } = state;
  if (!live.sessionId || event.sessionId !== live.sessionId || !event.kind) {
    return state;
  }

  let lastSeq = live.lastSeq;
  if (typeof event.seq === 'number') {
    if (event.seq <= live.lastSeq) {
      return state;
    }
    lastSeq = event.seq;
  }

  // Returns the same state object when nothing changed, so ignored frames
  // (status pings, run_state, ...) do not re-render the room.
  const withSeq = (frames: NormalizedMessage[]): RoomViewState => (
    frames === live.frames && lastSeq === live.lastSeq
      ? state
      : { ...state, live: { ...live, frames, lastSeq } }
  );

  switch (event.kind) {
    case 'chat_subscribed': {
      const pending = Array.isArray(event.pendingPermissions)
        ? (event.pendingPermissions as PendingPermissionRequest[])
        : state.pendingPermissions;
      return { ...state, pendingPermissions: pending };
    }

    case 'permission_request': {
      const requestId = typeof event.requestId === 'string' ? event.requestId : null;
      if (!requestId || state.pendingPermissions.some((request) => request.requestId === requestId)) {
        return withSeq(live.frames);
      }
      return {
        ...withSeq(live.frames),
        pendingPermissions: [...state.pendingPermissions, {
          requestId,
          toolName: typeof event.toolName === 'string' ? event.toolName : 'UnknownTool',
          input: event.input,
          context: event.context,
          sessionId: live.sessionId,
          receivedAt: new Date(),
        }],
      };
    }

    case 'permission_resolved':
    case 'permission_cancelled':
      return {
        ...withSeq(live.frames),
        pendingPermissions: state.pendingPermissions.filter((request) => request.requestId !== event.requestId),
      };

    case 'stream_delta': {
      const text = typeof event.content === 'string' ? event.content : '';
      if (!text) {
        return withSeq(live.frames);
      }
      const last = live.frames[live.frames.length - 1];
      if (last?.id === STREAMING_FRAME_ID) {
        return withSeq([...live.frames.slice(0, -1), { ...last, content: `${last.content ?? ''}${text}` }]);
      }
      return withSeq([...live.frames, {
        id: STREAMING_FRAME_ID,
        sessionId: live.sessionId,
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString(),
        provider: (event.provider as LLMProvider) ?? 'claude',
        kind: 'stream_delta',
        content: text,
      }]);
    }

    case 'stream_end':
      return withSeq(finalizeStreamingFrame(live.frames));

    case 'complete':
      return {
        ...withSeq(finalizeStreamingFrame(live.frames)),
        pendingPermissions: [],
      };

    default:
      break;
  }

  if (!LIVE_CONTENT_KINDS.has(event.kind) || isSyntheticPromptFrame(event)) {
    return withSeq(live.frames);
  }

  // Claude streams deltas and then sends the finished message; the preview
  // the deltas built is superseded by it.
  const frames = event.kind === 'text' && event.role === 'assistant'
    ? live.frames.filter((frame) => frame.id !== STREAMING_FRAME_ID)
    : live.frames;
  return withSeq([...frames, event as unknown as NormalizedMessage]);
};

/**
 * Merges everything the room view hears — REST snapshots, `room_message`,
 * `room_state` and the active participant's live frames — into one state.
 */
export function roomViewReducer(state: RoomViewState, action: RoomViewAction): RoomViewState {
  switch (action.type) {
    case 'detail_loaded': {
      const activeSessionId = action.detail.state.activeSessionId;
      // Keep a live buffer that still belongs to the running turn; a refetch
      // must not wipe the stream the user is watching.
      const live = activeSessionId && state.live.sessionId === activeSessionId
        ? state.live
        : { ...EMPTY_LIVE, sessionId: activeSessionId };
      return {
        ...state,
        detail: action.detail,
        live,
        pendingPermissions: live === state.live ? state.pendingPermissions : [],
      };
    }

    case 'room_message': {
      if (!state.detail) {
        return state;
      }
      const message = action.message;
      // The persisted reply replaces the live stream that produced it.
      const finishesLiveTurn = message.speaker !== 'user'
        && message.sessionId !== null
        && message.sessionId === state.live.sessionId;
      return {
        ...state,
        detail: { ...state.detail, messages: insertRoomMessage(state.detail.messages, message) },
        live: finishesLiveTurn ? EMPTY_LIVE : state.live,
        pendingPermissions: finishesLiveTurn ? [] : state.pendingPermissions,
      };
    }

    case 'room_state': {
      if (!state.detail) {
        return state;
      }
      const nextActive = action.state.activeSessionId;
      // A new speaker starts a fresh buffer (its `seq` restarts at 1). When the
      // room goes idle the buffer stays until the persisted reply lands.
      const startsNewTurn = nextActive !== null && nextActive !== state.live.sessionId;
      return {
        ...state,
        detail: { ...state.detail, state: action.state },
        live: startsNewTurn ? { ...EMPTY_LIVE, sessionId: nextActive } : state.live,
        pendingPermissions: startsNewTurn || nextActive === null ? [] : state.pendingPermissions,
      };
    }

    case 'live_frame':
      return applyLiveFrame(state, action.event);

    case 'permissions_answered':
      return {
        ...state,
        pendingPermissions: state.pendingPermissions.filter((request) => !action.requestIds.includes(request.requestId)),
      };

    default:
      return state;
  }
}
