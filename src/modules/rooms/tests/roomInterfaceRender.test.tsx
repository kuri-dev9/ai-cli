import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    splitWork: true,
    discussion: true,
    hostLed: false,
    autoCompact: true,
    createdAt: '2026-10-25T00:00:00.000Z',
  },
  participants: [
    { participantId: 'p-host', roomId: 'room-1', sessionId: 'host-session', provider: 'claude', model: null, displayName: '설계자', roleName: '설계', rolePrompt: '', persona: '', status: 'active', position: 0, isHost: true, permissionMode: 'ask' },
    { participantId: 'p-rev', roomId: 'room-1', sessionId: 'rev-session', provider: 'codex', model: null, displayName: '리뷰어', roleName: '리뷰', rolePrompt: '', persona: '', status: 'active', position: 1, isHost: false, permissionMode: 'ask' },
  ],
  formerParticipants: [],
  messages: [
    { id: 1, roomId: 'room-1', speaker: 'user', text: '로그인 화면 설계해줘', status: 'complete', sessionId: null, attachments: [], finalText: null, handoff: null, turnKind: null, task: null, createdAt: '2026-10-25T00:00:01.000Z' },
    {
      id: 2, roomId: 'room-1', speaker: 'p-host', text: '화면 구조를 살펴보는 중이에요\n\n설계안입니다\n@리뷰어', status: 'complete', sessionId: 'host-session',
      attachments: [], finalText: '설계안입니다\n@리뷰어', handoff: { kind: 'mention', participantId: 'p-rev' }, turnKind: 'reply', task: null, createdAt: '2026-10-25T00:00:02.000Z',
    },
  ],
  state: {
    status: 'idle', activeParticipantId: null, activeSessionId: null, activeParticipantIds: [], activeSessionIds: [], phase: 'idle',
    turnCount: 1, maxAutoTurns: 6, pendingUserMessage: false,
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
        update: (...args: unknown[]) => {
          roomCalls.push({ name: 'update', args });
          return ok(roomDetail);
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
      state: { ...roomDetail.state, status: 'running', activeParticipantId: 'p-rev', activeSessionId: 'rev-session', activeParticipantIds: ['p-rev'], activeSessionIds: ['rev-session'], phase: 'turn', turnCount: 2 },
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
    // The header carries the room-wide permission; a participant's own override
    // lives in its settings strip, which is closed here.
    expect(screen.getByLabelText('룸 권한')).toBeTruthy();
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

  it('opens one participant\'s settings beside the member list to change its permission or send it to standby', async () => {
    roomCalls.length = 0;
    await renderRoom();

    // 참가자는 버튼 하나로 접혀 있다. 펼친 목록에서 설정을 열어도 목록은 닫히지 않는다.
    fireEvent.click(screen.getByRole('button', { name: /^참가자 2/ }));
    fireEvent.click(screen.getByRole('button', { name: '리뷰어 설정' }));
    expect(screen.getByRole('button', { name: '설계자 설정' })).toBeTruthy();
    const region = screen.getByRole('region', { name: '리뷰어 설정' });
    expect(region).toBeTruthy();

    // 머리말에도 같은 이름의 단추가 있으므로 이 참가자의 것만 누른다.
    fireEvent.click(within(region).getByRole('button', { name: '전체 허용' }));
    await waitFor(() => expect(roomCalls.find((call) => call.name === 'updateParticipant')?.args)
      .toEqual(['room-1', 'p-rev', { permissionMode: 'full' }]));

    // 내보내는 것이 아니라 대기로 돌린다. 세션은 룸 밑에 그대로 남는다.
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '대기로' }));
    await waitFor(() => expect(roomCalls.find((call) => call.name === 'removeParticipant')?.args)
      .toEqual(['room-1', 'p-rev']));
    confirm.mockRestore();

    // The host is the room itself and has no remove button.
    fireEvent.click(screen.getByRole('button', { name: '설계자 설정' }));
    expect(screen.queryByRole('button', { name: '대기로' })).toBeNull();
  });

  it('shows a waiting message mid-turn with a button to interrupt the current speaker', async () => {
    roomCalls.length = 0;
    await renderRoom();

    emit({
      kind: 'room_state',
      roomId: 'room-1',
      state: { ...roomDetail.state, status: 'running', activeParticipantId: 'p-rev', activeSessionId: 'rev-session', activeParticipantIds: ['p-rev'], activeSessionIds: ['rev-session'], phase: 'turn', pendingUserMessage: true },
    });

    fireEvent.click(screen.getByRole('button', { name: '지금 끼어들기' }));
    await waitFor(() => expect(roomCalls.some((call) => call.name === 'interrupt')).toBe(true));
  });
  it('shows a reply as a card with its conclusion up front, the work folded away and the handoff at its foot', async () => {
    await renderRoom();

    // The handoff line itself is read into the footer rather than repeated in the text.
    expect(screen.queryByText('@리뷰어')).toBeNull();
    expect(screen.getByText('에게 넘김')).toBeTruthy();

    expect(screen.queryByText('화면 구조를 살펴보는 중이에요')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '작업 과정 보기' }));
    expect(screen.getByText('화면 구조를 살펴보는 중이에요')).toBeTruthy();
  });
  it('shows everyone working in parallel with their own live card, and toggles how the room collaborates', async () => {
    roomCalls.length = 0;
    sentFrames.length = 0;
    await renderRoom();

    emit({
      kind: 'room_state',
      roomId: 'room-1',
      state: {
        ...roomDetail.state,
        status: 'running',
        activeParticipantId: 'p-host',
        activeSessionId: 'host-session',
        activeParticipantIds: ['p-host', 'p-rev'],
        activeSessionIds: ['host-session', 'rev-session'],
        phase: 'working',
      },
    });

    expect(screen.getByText('2명 분담 작업 중')).toBeTruthy();
    // Both sessions are attached in one subscribe.
    expect(sentFrames).toContainEqual({
      type: 'chat.subscribe',
      sessions: [{ sessionId: 'host-session', lastSeq: 0 }, { sessionId: 'rev-session', lastSeq: 0 }],
    });
    emit({ kind: 'text', role: 'assistant', id: 'h1', sessionId: 'host-session', content: '인증 코드를 읽는 중', seq: 1, timestamp: '2026-10-25T00:00:05.000Z' });
    emit({ kind: 'text', role: 'assistant', id: 'r1', sessionId: 'rev-session', content: '테스트를 쓰는 중', seq: 1, timestamp: '2026-10-25T00:00:05.000Z' });
    expect(screen.getByText('인증 코드를 읽는 중')).toBeTruthy();
    expect(screen.getByText('테스트를 쓰는 중')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '의견' }));
    await waitFor(() => expect(roomCalls.find((call) => call.name === 'update')?.args).toEqual(['room-1', { discussion: false }]));
  });
});
