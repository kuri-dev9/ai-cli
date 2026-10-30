import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { RoomDetail } from '@/shared/types';
import type * as ApiModule from '@/shared/api';

// 초대 창이 보낸 요청. 순서까지 본다.
const inviteCalls: Array<{ name: string; args: unknown[] }> = [];
// 이 이름을 초대하면 서버가 거절한다. 중간에 실패했을 때를 본다.
let rejectName: string | null = null;

const roomDetail = { room: { roomId: 'room-1' }, participants: [], formerParticipants: [] } as unknown as RoomDetail;

vi.mock('@/shared/hooks/useEnabledProviders', () => ({ useEnabledProviders: () => ['claude', 'codex'] }));
vi.mock('@/modules/rooms/hooks/useRoomRolePresets', () => ({ useRoomRolePresets: () => [] }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
  const fail = () => Promise.resolve(new Response(JSON.stringify({ success: false, error: { message: '거절' } }), { status: 409 }));
  return {
    ...actual,
    api: {
      ...actual.api,
      providers: { ...actual.api.providers, models: () => ok({ models: { OPTIONS: [], DEFAULT: '' } }) },
      rooms: {
        ...actual.api.rooms,
        create: (...args: unknown[]) => {
          inviteCalls.push({ name: 'create', args });
          return ok(roomDetail);
        },
        addParticipant: (...args: unknown[]) => {
          inviteCalls.push({ name: 'addParticipant', args });
          return (args[1] as { displayName: string }).displayName === rejectName ? fail() : ok(roomDetail);
        },
      },
    },
  };
});

const initialLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('ko');
});

afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

beforeEach(() => {
  inviteCalls.length = 0;
  rejectName = null;
});

const renderModal = async (target: { kind: 'create'; resolveHostSessionId: () => Promise<string> } | { kind: 'add'; roomId: string }) => {
  const { default: InviteParticipantModal } = await import('@/modules/rooms/InviteParticipantModal');
  const onInvited = vi.fn();
  const onOpenChange = vi.fn();
  render(React.createElement(InviteParticipantModal, { open: true, onOpenChange, target, takenNames: ['설계자'], onInvited }));
  return { onInvited, onOpenChange };
};

const fillInvitee = (displayName: string, roleName: string) => {
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: displayName } });
  fireEvent.change(screen.getByLabelText('역할'), { target: { value: roleName } });
};

describe('InviteParticipantModal with several invitees', () => {
  it('adds everyone on the list plus the one left in the form, one by one', async () => {
    const { onInvited, onOpenChange } = await renderModal({ kind: 'add', roomId: 'room-1' });

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('체커', '리뷰어');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('테스티', '테스터');

    fireEvent.click(screen.getByRole('button', { name: '3명 초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(inviteCalls.map((call) => (call.args[1] as { displayName: string }).displayName)).toEqual(['빌더', '체커', '테스티']);
    expect(inviteCalls.every((call) => call.name === 'addParticipant' && call.args[0] === 'room-1')).toBe(true);
    expect(onInvited).toHaveBeenCalledTimes(3);
  });

  it('rejects a name already on the list', async () => {
    await renderModal({ kind: 'add', roomId: 'room-1' });

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('빌더', '구현자');

    expect((screen.getByRole('button', { name: '목록에 담기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates the room with the first invitee and adds the rest to it', async () => {
    const { onOpenChange } = await renderModal({ kind: 'create', resolveHostSessionId: () => Promise.resolve('host-session') });

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('체커', '리뷰어');
    fireEvent.click(screen.getByRole('button', { name: '2명 초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(inviteCalls.map((call) => call.name)).toEqual(['create', 'addParticipant']);
    // 룸을 만드는 첫 참가자는 늘 상주다. 부를 호스트가 아직 말하기 전이다.
    expect((inviteCalls[0].args[0] as { participant: { status: string } }).participant.status).toBe('active');
    expect(inviteCalls[1].args[0]).toBe('room-1');
  });

  it('keeps whoever did not get in, so pressing invite again retries only them', async () => {
    const { onOpenChange } = await renderModal({ kind: 'add', roomId: 'room-1' });
    rejectName = '체커';

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('체커', '리뷰어');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fireEvent.click(screen.getByRole('button', { name: '2명 초대' }));

    await screen.findByRole('alert');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByRole('button', { name: '빌더 빼기' })).toBeNull();
    expect(screen.getByRole('button', { name: '체커 빼기' })).toBeTruthy();
  });
});
