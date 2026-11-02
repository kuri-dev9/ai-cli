import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import type { RoomRolePreset } from '@/modules/rooms/utils/roomRolePresets';
import type { RoomDetail } from '@/shared/types';
import type * as ApiModule from '@/shared/api';

// 초대 창이 보낸 요청. 순서까지 본다.
const inviteCalls: Array<{ name: string; args: unknown[] }> = [];
// 이 이름을 초대하면 서버가 거절한다. 중간에 실패했을 때를 본다.
let rejectName: string | null = null;

const roomDetail = { room: { roomId: 'room-1' }, participants: [], formerParticipants: [] } as unknown as RoomDetail;

vi.mock('@/shared/hooks/useEnabledProviders', () => ({ useEnabledProviders: () => ['claude', 'codex'] }));
// 프리셋 칩을 보는 테스트만 채운다.
let presets: RoomRolePreset[] = [];
vi.mock('@/modules/rooms/hooks/useRoomRolePresets', () => ({ useRoomRolePresets: () => presets }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200 }));
  const fail = () => Promise.resolve(new Response(JSON.stringify({ success: false, error: { message: '거절' } }), { status: 409 }));
  return {
    ...actual,
    api: {
      ...actual.api,
      providers: {
        ...actual.api.providers,
        // 프로바이더마다 모델 목록이 다르다. 줄마다 그 프로바이더의 목록을 보여야 한다.
        models: (provider: string) => ok({
          models: {
            OPTIONS: provider === 'codex' ? [{ value: 'gpt-5', label: 'GPT-5' }] : [{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }],
            DEFAULT: '',
          },
        }),
        claudeAccounts: () => ok([]),
      },
      rooms: {
        ...actual.api.rooms,
        create: (...args: unknown[]) => {
          inviteCalls.push({ name: 'create', args });
          return ok(roomDetail);
        },
        addParticipant: (...args: unknown[]) => {
          inviteCalls.push({ name: 'addParticipant', args });
          const { displayName } = args[1] as { displayName: string };
          // 방장을 넘길 때 이름으로 참가자 id 를 찾으므로, 방금 들어온 사람을 담아 돌려준다.
          return displayName === rejectName
            ? fail()
            : ok({ ...roomDetail, participants: [{ participantId: `p-${displayName}`, displayName }] });
        },
        setLeader: (...args: unknown[]) => {
          inviteCalls.push({ name: 'setLeader', args });
          return ok(roomDetail);
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
  presets = [];
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

  it('picks several presets at once and invites them together', async () => {
    presets = [
      { id: 'a', displayName: '빌더', roleName: '구현자', rolePrompt: '고친다', persona: '', provider: null },
      { id: 'b', displayName: '체커', roleName: '리뷰어', rolePrompt: '본다', persona: '', provider: null },
      { id: 'c', displayName: '서기', roleName: '정리자', rolePrompt: '', persona: '', provider: null },
    ];
    const { onOpenChange } = await renderModal({ kind: 'add', roomId: 'room-1' });

    fireEvent.click(screen.getByRole('button', { name: /빌더/ }));
    fireEvent.click(screen.getByRole('button', { name: /체커/ }));
    fireEvent.click(screen.getByRole('button', { name: /서기/ }));
    // 다시 누르면 빠진다.
    fireEvent.click(screen.getByRole('button', { name: /서기\s*정리자/, pressed: true }));

    fireEvent.click(screen.getByRole('button', { name: '2명 초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(inviteCalls.map((call) => (call.args[1] as { displayName: string; rolePrompt?: string }).rolePrompt)).toEqual(['고친다', '본다']);
  });

  it('hands host rights to the invitee picked as host and lets them join right away', async () => {
    const { onOpenChange } = await renderModal({ kind: 'add', roomId: 'room-1' });

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('체커', '리뷰어');
    fireEvent.change(screen.getByLabelText('방장 (먼저 시작)'), { target: { value: '체커' } });
    fireEvent.click(screen.getByRole('button', { name: '2명 초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(inviteCalls.map((call) => call.name)).toEqual(['addParticipant', 'addParticipant', 'setLeader']);
    expect((inviteCalls[1].args[1] as { status: string }).status).toBe('active');
    expect(inviteCalls[2].args).toEqual(['room-1', 'p-체커']);
  });

  it('lets each person on the list pick their own provider and model', async () => {
    const { onOpenChange } = await renderModal({ kind: 'add', roomId: 'room-1' });

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('체커', '리뷰어');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));

    await screen.findAllByRole('option', { name: 'Opus' });
    fireEvent.change(screen.getByLabelText('빌더의 모델'), { target: { value: 'opus' } });
    fireEvent.click(within(screen.getByRole('group', { name: '체커의 프로바이더' })).getByRole('button', { name: /Codex/ }));
    await within(screen.getByLabelText('체커의 모델')).findByRole('option', { name: 'GPT-5' });
    fireEvent.change(screen.getByLabelText('체커의 모델'), { target: { value: 'gpt-5' } });

    fireEvent.click(screen.getByRole('button', { name: '2명 초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(inviteCalls.map((call) => {
      const { provider, model } = call.args[1] as { provider: string; model: string | null };
      return [provider, model];
    })).toEqual([['claude', 'opus'], ['codex', 'gpt-5']]);
  });

  it('on a brand-new conversation, the picked host becomes the conversation itself instead of joining as an extra member', async () => {
    const resolveHostSessionId = vi.fn((_provider?: string) => Promise.resolve('fresh-session'));
    const { onOpenChange } = await renderModal({ kind: 'create', fresh: true, resolveHostSessionId } as never);

    // 따로 적을 "내 세션" 칸이 없다.
    expect(screen.queryByText('내 세션(호스트) 이름 · 역할 (선택)')).toBeNull();

    fillInvitee('빌더', '구현자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fillInvitee('케이', '정리자');
    fireEvent.click(screen.getByRole('button', { name: '목록에 담기' }));
    fireEvent.click(within(screen.getByRole('group', { name: '케이의 프로바이더' })).getByRole('button', { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText('방장 (먼저 시작)'), { target: { value: '케이' } });

    fireEvent.click(screen.getByRole('button', { name: '2명 초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // 방장의 프로바이더로 세션을 열고, 방장은 호스트로, 나머지만 참가자로 간다.
    expect(resolveHostSessionId).toHaveBeenCalledWith('codex');
    expect(inviteCalls.map((call) => call.name)).toEqual(['create']);
    const input = inviteCalls[0].args[0] as { host: { displayName: string; roleName: string }; participant: { displayName: string } };
    expect(input.host).toMatchObject({ displayName: '케이', roleName: '정리자' });
    expect(input.participant.displayName).toBe('빌더');
  });

  it('on a brand-new conversation, one picked person is enough to open the room', async () => {
    const { onOpenChange } = await renderModal({ kind: 'create', fresh: true, resolveHostSessionId: () => Promise.resolve('fresh-session') } as never);

    fillInvitee('케이', '정리자');
    fireEvent.click(screen.getByRole('button', { name: '초대' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(inviteCalls.map((call) => call.name)).toEqual(['create']);
    const input = inviteCalls[0].args[0] as { host: { displayName: string }; participant?: unknown };
    expect(input.host.displayName).toBe('케이');
    expect(input.participant).toBeUndefined();
  });
});
