import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import { SessionShareSection } from '@/modules/session-share';
import { buildShareUrl } from '@/modules/session-share/SessionShareSection';

/**
 * 세션 설정 안의 "외부 공유".
 *
 * 링크는 이 세션의 권한으로 만들어지고, 만들자마자 복사되며, 끊으면 목록에서
 * 사라진다. 열린 링크의 권한이 지금 세션 권한과 다르면 맞춘다.
 */

const state = vi.hoisted(() => ({
  shares: [] as Array<Record<string, unknown>>,
}));

const calls = vi.hoisted(() => ({
  create: vi.fn(),
  revoke: vi.fn(),
  sync: vi.fn(),
  copy: vi.fn(),
}));

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');
  return {
    ...actual,
    api: {
      user: {
        preferences: async () => jsonResponse({ preferences: {} }),
        savePreferences: async () => jsonResponse({}),
      },
      sessionShares: {
        list: async () => jsonResponse({ shares: state.shares }),
        create: async (body: Record<string, unknown>) => {
          calls.create(body);
          return jsonResponse({
            share: { id: 7, token: 'new-token', permissionMode: body.permissionMode, expiresAt: null, createdAt: '' },
          }, 201);
        },
        revoke: async (id: number) => {
          calls.revoke(id);
          return jsonResponse({ revoked: true });
        },
        syncPermission: async (sessionId: string, permissionMode: string) => {
          calls.sync(sessionId, permissionMode);
          return jsonResponse({ updated: 1 });
        },
      },
    },
  };
});

vi.mock('@/shared/utils', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/utils');
  return {
    ...actual,
    copyTextToClipboard: async (text: string) => {
      calls.copy(text);
      return true;
    },
  };
});

beforeEach(() => {
  state.shares = [];
  Object.values(calls).forEach((mock) => mock.mockClear());
  localStorage.clear();
});

const renderSection = (permissionMode = 'default') => render(React.createElement(SessionShareSection, {
  sessionId: 'session-1',
  permissionMode,
  permissionLabel: permissionMode,
}));

test('링크 주소는 외부 주소가 있으면 그쪽으로 만든다', () => {
  assert.equal(buildShareUrl('tok', '', 'http://localhost:18200'), 'http://localhost:18200/share/tok');
  assert.equal(buildShareUrl('tok', 'https://tunnel.example.com/', 'http://localhost:18200'), 'https://tunnel.example.com/share/tok');
});

test('링크를 만들면 이 세션의 권한으로 만들고 바로 복사한다', async () => {
  renderSection('acceptEdits');
  await screen.findByText('열려 있는 링크가 없습니다.');

  fireEvent.change(screen.getByLabelText('외부 주소 (선택)'), { target: { value: 'https://tunnel.example.com' } });
  fireEvent.change(screen.getByLabelText('유효 기간'), { target: { value: '168' } });
  fireEvent.click(screen.getByRole('button', { name: '링크 만들기' }));

  await waitFor(() => assert.equal(calls.create.mock.calls.length, 1));
  assert.deepEqual(calls.create.mock.calls[0][0], {
    sessionId: 'session-1',
    permissionMode: 'acceptEdits',
    expiresInHours: 168,
  });
  await waitFor(() => assert.deepEqual(calls.copy.mock.calls.at(-1), ['https://tunnel.example.com/share/new-token']));
  await screen.findByRole('button', { name: '복사됨' });
});

test('묻기 권한이면 주인이 승인해야 한다고 알리고, 끊으면 목록에서 빠진다', async () => {
  state.shares = [{ id: 3, token: 'old-token', permissionMode: 'default', expiresAt: null, createdAt: '' }];
  renderSection('default');

  await screen.findByText('게스트가 도구를 쓰려 하면 이 브라우저에서 승인해야 진행됩니다.');
  await screen.findByText('기한 없음');

  fireEvent.click(screen.getByRole('button', { name: '끊기' }));
  await waitFor(() => assert.deepEqual(calls.revoke.mock.calls, [[3]]));
  await screen.findByText('열려 있는 링크가 없습니다.');
  // 권한이 같으면 맞출 것도 없다.
  assert.equal(calls.sync.mock.calls.length, 0);
});

test('열린 링크의 권한이 지금과 다르면 세션 권한으로 맞춘다', async () => {
  state.shares = [{ id: 3, token: 'old-token', permissionMode: 'default', expiresAt: null, createdAt: '' }];
  renderSection('bypassPermissions');

  await waitFor(() => assert.deepEqual(calls.sync.mock.calls, [['session-1', 'bypassPermissions']]));
  await screen.findByText(/승인 없이 실행합니다/);
});
