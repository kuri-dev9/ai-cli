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
 * One running participant's turn as it streams in. Several run at once when
 * the lead splits the work or the others weigh in, so there is one buffer per
 * running session; frames from any other session are ignored.
 */
export type RoomLiveBuffer = {
  sessionId: string;
  frames: NormalizedMessage[];
  /** Highest `seq` applied, so a replay after `chat.subscribe` is not drawn twice. */
  lastSeq: number;
};

export type RoomViewState = {
  detail: RoomDetail | null;
  /** The running sessions' streams, in the order the server lists them as active. */
  lives: RoomLiveBuffer[];
  /** Permission prompts raised by the running participants, answered from the room view. */
  pendingPermissions: PendingPermissionRequest[];
};

export type RoomViewAction =
  | { type: 'detail_loaded'; detail: RoomDetail }
  | { type: 'room_message'; message: RoomMessage }
  | { type: 'room_state'; state: RoomRuntimeState }
  | { type: 'live_frame'; event: ServerEvent }
  | { type: 'permissions_answered'; requestIds: string[] };

export const INITIAL_ROOM_VIEW_STATE: RoomViewState = {
  detail: null,
  lives: [],
  pendingPermissions: [],
};

/**
 * One buffer per active session: a session that keeps running keeps its
 * stream, a newly active one starts empty (its `seq` restarts at 1), and one
 * that stopped is dropped. The server takes a participant off the active list
 * only after its reply is persisted, so nothing visible is lost.
 */
const syncLiveBuffers = (lives: RoomLiveBuffer[], activeSessionIds: string[]): RoomLiveBuffer[] => {
  const next = activeSessionIds.map((sessionId) => (
    lives.find((buffer) => buffer.sessionId === sessionId) ?? { sessionId, frames: [], lastSeq: 0 }
  ));
  const unchanged = next.length === lives.length && next.every((buffer, index) => buffer === lives[index]);
  return unchanged ? lives : next;
};

/** Active sessions from a state, falling back to the single field older servers send. */
const activeSessionsOf = (state: RoomRuntimeState): string[] => (
  state.activeSessionIds ?? (state.activeSessionId ? [state.activeSessionId] : [])
);

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
  const bufferIndex = state.lives.findIndex((buffer) => buffer.sessionId === event.sessionId);
  if (bufferIndex < 0 || !event.kind) {
    return state;
  }
  const live = state.lives[bufferIndex];

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
      : { ...state, lives: state.lives.map((buffer, index) => (index === bufferIndex ? { ...live, frames, lastSeq } : buffer)) }
  );

  switch (event.kind) {
    case 'chat_subscribed': {
      if (!Array.isArray(event.pendingPermissions)) {
        return state;
      }
      // The ack lists this session's open prompts; the other sessions keep theirs.
      const pending = (event.pendingPermissions as PendingPermissionRequest[])
        .map((request) => ({ ...request, sessionId: request.sessionId ?? live.sessionId }));
      return {
        ...state,
        pendingPermissions: [
          ...state.pendingPermissions.filter((request) => request.sessionId !== live.sessionId),
          ...pending,
        ],
      };
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
        pendingPermissions: state.pendingPermissions.filter((request) => request.sessionId !== live.sessionId),
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

/** Drops prompts whose session is no longer running; nobody is left to answer them. */
const keepActivePermissions = (requests: PendingPermissionRequest[], lives: RoomLiveBuffer[]): PendingPermissionRequest[] => {
  const kept = requests.filter((request) => lives.some((buffer) => buffer.sessionId === request.sessionId));
  return kept.length === requests.length ? requests : kept;
};

/**
 * Merges everything the room view hears — REST snapshots, `room_message`,
 * `room_state` and the active participants' live frames — into one state.
 */
export function roomViewReducer(state: RoomViewState, action: RoomViewAction): RoomViewState {
  switch (action.type) {
    case 'detail_loaded': {
      // Streams of turns still running survive a refetch; the user is watching them.
      const lives = syncLiveBuffers(state.lives, activeSessionsOf(action.detail.state));
      return {
        ...state,
        detail: action.detail,
        lives,
        pendingPermissions: keepActivePermissions(state.pendingPermissions, lives),
      };
    }

    case 'room_message': {
      if (!state.detail) {
        return state;
      }
      const message = action.message;
      // The persisted reply replaces the live stream that produced it.
      const finishedSessionId = message.speaker !== 'user' ? message.sessionId : null;
      const lives = finishedSessionId
        ? state.lives.filter((buffer) => buffer.sessionId !== finishedSessionId)
        : state.lives;
      return {
        ...state,
        detail: { ...state.detail, messages: insertRoomMessage(state.detail.messages, message) },
        lives: lives.length === state.lives.length ? state.lives : lives,
        pendingPermissions: keepActivePermissions(state.pendingPermissions, lives),
      };
    }

    case 'room_state': {
      if (!state.detail) {
        return state;
      }
      const lives = syncLiveBuffers(state.lives, activeSessionsOf(action.state));
      return {
        ...state,
        detail: { ...state.detail, state: action.state },
        lives,
        pendingPermissions: keepActivePermissions(state.pendingPermissions, lives),
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
