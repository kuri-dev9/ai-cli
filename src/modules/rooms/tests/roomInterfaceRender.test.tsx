import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { Project, RoomDetail, ServerEvent } from '@/shared/types';
import type * as ApiModule from '@/shared/api';

const listeners = new Set<(event: ServerEvent) => void>();
// Room calls the composer and the settings strip make, recorded for the assertions.
const roomCalls: Array<{ name: string; args: unknown[] }> = [];
const sentFrames: unknown[] = [];

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendMessage: (frame: unknown) => sentFrames.push(frame),
  }),
}));

const roomDetail: RoomDetail = {
  room: {
    roomId: 'room-1',
    hostSessionId: 'host-session',
    projectPath: '/tmp/project',
    permissionMode: 'ask',
    maxAutoTurns: 6,
    createdAt: '2026-10-25T00:00:00.000Z',
  },
  participants: [
    { participantId: 'p-host', roomId: 'room-1', sessionId: 'host-session', provider: 'claude', model: null, displayName: '설계자', roleName: '설계', rolePrompt: '', position: 0, isHost: true, permissionMode: 'ask' },
    { participantId: 'p-rev', roomId: 'room-1', sessionId: 'rev-session', provider: 'codex', model: null, displayName: '리뷰어', roleName: '리뷰', rolePrompt: '', position: 1, isHost: false, permissionMode: 'ask' },
  ],
  formerParticipants: [],
  messages: [
    { id: 1, roomId: 'room-1', speaker: 'user', text: '로그인 화면 설계해줘', status: 'complete', sessionId: null, attachments: [], createdAt: '2026-10-25T00:00:01.000Z' },
    { id: 2, roomId: 'room-1', speaker: 'p-host', text: '설계안입니다', status: 'complete', sessionId: 'host-session', attachments: [], createdAt: '2026-10-25T00:00:02.000Z' },
  ],
  state: {
    status: 'idle', activeParticipantId: null, activeSessionId: null, turnCount: 1, maxAutoTurns: 6, pendingUserMessage: false,
  },
};

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
  return {
    ...actual,
    api: {
      ...actual.api,
      rooms: {
        ...actual.api.rooms,
        list: () => ok({ rooms: [] }),
        bySession: () => ok(roomDetail),
        get: () => ok(roomDetail),
        postMessage: (...args: unknown[]) => {
          roomCalls.push({ name: 'postMessage', args });
          return ok({});
        },
        updateParticipant: (...args: unknown[]) => {
          roomCalls.push({ name: 'updateParticipant', args });
          return ok(roomDetail);
        },
        removeParticipant: (...args: unknown[]) => {
          roomCalls.push({ name: 'removeParticipant', args });
          return ok(roomDetail);
        },
        interrupt: (...args: unknown[]) => {
          roomCalls.push({ name: 'interrupt', args });
          return ok({});
        },
      },
    },
  };
});

const project = { projectId: 'project-1', displayName: 'Project', path: '/tmp/project' } as unknown as Project;
const initialLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('ko');
  // Everything else the composer loads (models, commands, drafts, usage) answers empty.
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify({ success: true, data: null }), { status: 200 })));
});

afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
  vi.unstubAllGlobals();
});

const renderRoom = async () => {
  const { RoomInterface } = await import('@/modules/rooms');
  render(React.createElement(
    UiPreferencesProvider,
    null,
    React.createElement(RoomInterface, {
      hostSessionId: 'host-session',
      hostSession: { id: 'host-session', __provider: 'claude' },
      selectedProject: project,
    }),
  ));
  await waitFor(() => expect(screen.getByText('설계안입니다')).toBeTruthy());
};

const emit = (event: ServerEvent) => {
  act(() => {
    for (const listener of listeners) listener(event);
  });
};

describe('RoomInterface', () => {
  it('renders the timeline with speaker badges, then streams the active participant live', async () => {
    const { RoomInterface } = await import('@/modules/rooms');
    render(React.createElement(
      UiPreferencesProvider,
      null,
      React.createElement(RoomInterface, { hostSessionId: 'host-session', selectedProject: project }),
    ));

    await waitFor(() => expect(screen.getByText('설계안입니다')).toBeTruthy());
    expect(screen.getByText('로그인 화면 설계해줘')).toBeTruthy();
    expect(screen.getAllByText('설계자').length).toBeGreaterThan(0);
    expect(screen.getByText('대기 중')).toBeTruthy();

    emit({
      kind: 'room_state',
      roomId: 'room-1',
      state: { ...roomDetail.state, status: 'running', activeParticipantId: 'p-rev', activeSessionId: 'rev-session', turnCount: 2 },
    });

    expect(screen.getByText('리뷰어 작업 중')).toBeTruthy();
    expect(sentFrames).toContainEqual({ type: 'chat.subscribe', sessions: [{ sessionId: 'rev-session', lastSeq: 0 }] });

    emit({ kind: 'text', role: 'user', id: 'local_1', sessionId: 'rev-session', content: 'INTERNAL PROMPT', seq: 1, timestamp: '2026-10-25T00:00:03.000Z' });
    emit({ kind: 'text', role: 'assistant', id: 'a1', sessionId: 'rev-session', content: '검토 중입니다', seq: 2, timestamp: '2026-10-25T00:00:04.000Z' });

    expect(screen.queryByText('INTERNAL PROMPT')).toBeNull();
    expect(screen.getByText('검토 중입니다')).toBeTruthy();

    // Frames for another room are ignored.
    emit({ kind: 'room_message', roomId: 'room-2', message: { ...roomDetail.messages[0], id: 50, text: '다른 방' } });
    expect(screen.queryByText('다른 방')).toBeNull();
  });

  it('uses the chat composer and sends to the room, with slash commands going to the host', async () => {
    roomCalls.length = 0;
    await renderRoom();

    const textarea = screen.getByPlaceholderText('메시지를 입력하세요 (@이름으로 지정)') as HTMLTextAreaElement;
    // The same footer a chat has: attach button and token usage.
    expect(screen.getByLabelText(i18n.t('chat:input.attachFiles'))).toBeTruthy();
    // The room-wide permission picker moved into each participant's settings.
    expect(screen.queryByLabelText('권한')).toBeNull();

    fireEvent.change(textarea, { target: { value: '로그인도 봐줘' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(roomCalls.some((call) => call.name === 'postMessage')).toBe(true));
    expect(roomCalls.find((call) => call.name === 'postMessage')?.args).toEqual([
      'room-1',
      { content: '로그인도 봐줘', attachments: [], hostCommand: false },
    ]);

    roomCalls.length = 0;
    fireEvent.change(textarea, { target: { value: '/compact' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() => expect(roomCalls.some((call) => call.name === 'postMessage')).toBe(true));
    expect(roomCalls.find((call) => call.name === 'postMessage')?.args).toEqual([
      'room-1',
      { content: '/compact', attachments: [], hostCommand: true },
    ]);
  });

  it('opens one participant\'s settings under the chips to change its permission or remove it', async () => {
    roomCalls.length = 0;
    await renderRoom();

    fireEvent.click(screen.getByRole('button', { name: '리뷰어 설정' }));
    const region = screen.getByRole('region', { name: '리뷰어 설정' });
    expect(region).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '전체 허용' }));
    await waitFor(() => expect(roomCalls.find((call) => call.name === 'updateParticipant')?.args)
      .toEqual(['room-1', 'p-rev', { permissionMode: 'full' }]));

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '퇴장' }));
    await waitFor(() => expect(roomCalls.find((call) => call.name === 'removeParticipant')?.args)
      .toEqual(['room-1', 'p-rev']));
    confirm.mockRestore();

    // The host is the room itself and has no remove button.
    fireEvent.click(screen.getByRole('button', { name: '설계자 설정' }));
    expect(screen.queryByRole('button', { name: '퇴장' })).toBeNull();
  });

  it('shows a waiting message mid-turn with a button to interrupt the current speaker', async () => {
    roomCalls.length = 0;
    await renderRoom();

    emit({
      kind: 'room_state',
      roomId: 'room-1',
      state: { ...roomDetail.state, status: 'running', activeParticipantId: 'p-rev', activeSessionId: 'rev-session', pendingUserMessage: true },
    });

    fireEvent.click(screen.getByRole('button', { name: '지금 끼어들기' }));
    await waitFor(() => expect(roomCalls.some((call) => call.name === 'interrupt')).toBe(true));
  });
});
