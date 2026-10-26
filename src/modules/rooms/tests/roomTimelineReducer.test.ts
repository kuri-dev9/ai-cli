import { describe, expect, it } from 'vitest';

import type { RoomDetail, RoomMessage, RoomRuntimeState, ServerEvent } from '@/shared/types';
import {
  INITIAL_ROOM_VIEW_STATE,
  isSyntheticPromptFrame,
  roomViewReducer,
} from '@/modules/rooms/utils/roomTimelineReducer';
import type { RoomViewState } from '@/modules/rooms/utils/roomTimelineReducer';

const idleState: RoomRuntimeState = {
  status: 'idle',
  activeParticipantId: null,
  activeSessionId: null,
  turnCount: 0,
  maxAutoTurns: 6,
  pendingUserMessage: false,
};

const runningState = (sessionId: string, participantId: string): RoomRuntimeState => ({
  ...idleState,
  status: 'running',
  activeParticipantId: participantId,
  activeSessionId: sessionId,
  turnCount: 1,
});

const detail: RoomDetail = {
  room: {
    roomId: 'room-1',
    hostSessionId: 'host-session',
    projectPath: '/tmp/project',
    permissionMode: 'ask',
    maxAutoTurns: 6,
    createdAt: '2026-10-25T00:00:00.000Z',
  },
  participants: [],
  formerParticipants: [],
  messages: [],
  state: idleState,
};

const message = (overrides: Partial<RoomMessage>): RoomMessage => ({
  id: 1,
  roomId: 'room-1',
  speaker: 'user',
  text: 'hello',
  status: 'complete',
  sessionId: null,
  attachments: [],
  finalText: null,
  handoff: null,
  createdAt: '2026-10-25T00:00:01.000Z',
  ...overrides,
});

const frame = (overrides: ServerEvent): ServerEvent => ({
  sessionId: 'reviewer-session',
  timestamp: '2026-10-25T00:00:02.000Z',
  provider: 'claude',
  ...overrides,
});

const loaded = (): RoomViewState => roomViewReducer(INITIAL_ROOM_VIEW_STATE, { type: 'detail_loaded', detail });

const running = (): RoomViewState =>
  roomViewReducer(loaded(), { type: 'room_state', state: runningState('reviewer-session', 'p-reviewer') });

describe('roomViewReducer', () => {
  it('keeps room messages ordered by id and deduplicated', () => {
    let state = loaded();
    state = roomViewReducer(state, { type: 'room_message', message: message({ id: 3, text: 'third' }) });
    state = roomViewReducer(state, { type: 'room_message', message: message({ id: 2, text: 'second' }) });
    state = roomViewReducer(state, { type: 'room_message', message: message({ id: 3, text: 'third' }) });

    expect(state.detail?.messages.map((entry) => entry.id)).toEqual([2, 3]);
  });

  it('starts a live buffer for the new speaker on room_state', () => {
    const state = running();

    expect(state.detail?.state.activeParticipantId).toBe('p-reviewer');
    expect(state.live).toEqual({ sessionId: 'reviewer-session', frames: [], lastSeq: 0 });
  });

  it('drops the synthetic local_ prompt frame and frames from other sessions', () => {
    let state = running();
    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'text', role: 'user', id: 'local_123', content: 'internal prompt', seq: 1 }),
    });
    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'text', role: 'assistant', id: 'x', content: 'other', sessionId: 'someone-else' }),
    });

    expect(state.live.frames).toEqual([]);
    expect(state.live.lastSeq).toBe(1);
  });

  it('accumulates stream deltas and replaces them with the finished assistant text', () => {
    let state = running();
    state = roomViewReducer(state, { type: 'live_frame', event: frame({ kind: 'stream_delta', content: 'Hel', seq: 2 }) });
    state = roomViewReducer(state, { type: 'live_frame', event: frame({ kind: 'stream_delta', content: 'lo', seq: 3 }) });

    expect(state.live.frames).toHaveLength(1);
    expect(state.live.frames[0]).toMatchObject({ kind: 'stream_delta', content: 'Hello' });

    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'text', role: 'assistant', id: 'a1', content: 'Hello!', seq: 4 }),
    });

    expect(state.live.frames).toHaveLength(1);
    expect(state.live.frames[0]).toMatchObject({ kind: 'text', content: 'Hello!' });
  });

  it('ignores replayed frames whose seq was already applied', () => {
    let state = running();
    const toolUse = frame({ kind: 'tool_use', id: 't1', toolName: 'Read', toolId: 'tool-1', seq: 5 });
    state = roomViewReducer(state, { type: 'live_frame', event: toolUse });
    const afterFirst = state;
    state = roomViewReducer(state, { type: 'live_frame', event: toolUse });

    expect(state).toBe(afterFirst);
    expect(state.live.frames).toHaveLength(1);
  });

  it('tracks permission prompts for the live session and clears them when answered', () => {
    let state = running();
    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'permission_request', requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } }),
    });

    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.pendingPermissions[0]).toMatchObject({ requestId: 'req-1', toolName: 'Bash', sessionId: 'reviewer-session' });

    state = roomViewReducer(state, { type: 'permissions_answered', requestIds: ['req-1'] });
    expect(state.pendingPermissions).toEqual([]);
  });

  it('clears the live buffer when the participant reply is persisted', () => {
    let state = running();
    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'tool_use', id: 't1', toolName: 'Read', toolId: 'tool-1', seq: 1 }),
    });
    state = roomViewReducer(state, {
      type: 'room_message',
      message: message({ id: 9, speaker: 'p-reviewer', sessionId: 'reviewer-session', text: 'LGTM' }),
    });

    expect(state.live).toEqual({ sessionId: null, frames: [], lastSeq: 0 });
    expect(state.detail?.messages.at(-1)?.text).toBe('LGTM');
  });

  it('keeps a user message from clearing the live buffer', () => {
    let state = running();
    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'tool_use', id: 't1', toolName: 'Read', toolId: 'tool-1', seq: 1 }),
    });
    state = roomViewReducer(state, { type: 'room_message', message: message({ id: 10, text: '@설계자 잠깐' }) });

    expect(state.live.frames).toHaveLength(1);
  });

  it('keeps the live buffer across a refetch of the same running turn', () => {
    let state = running();
    state = roomViewReducer(state, {
      type: 'live_frame',
      event: frame({ kind: 'tool_use', id: 't1', toolName: 'Read', toolId: 'tool-1', seq: 1 }),
    });
    state = roomViewReducer(state, {
      type: 'detail_loaded',
      detail: { ...detail, state: runningState('reviewer-session', 'p-reviewer') },
    });

    expect(state.live.frames).toHaveLength(1);
  });
});

describe('isSyntheticPromptFrame', () => {
  it('matches only user text rows with a local_ id', () => {
    expect(isSyntheticPromptFrame({ kind: 'text', role: 'user', id: 'local_1' })).toBe(true);
    expect(isSyntheticPromptFrame({ kind: 'text', role: 'user', id: 'msg_1' })).toBe(false);
    expect(isSyntheticPromptFrame({ kind: 'text', role: 'assistant', id: 'local_1' })).toBe(false);
  });
});
