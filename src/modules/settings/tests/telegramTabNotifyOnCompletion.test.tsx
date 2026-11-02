import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import TelegramTab from '@/modules/settings/tabs/TelegramTab';

/**
 * "완료 알림" 토글: 넘기기(핸드오프)를 켜지 않은 대화·룸도 끝날 때마다 텔레그램
 * 알림을 받을지. 권한 모드와 달리 저장 버튼 없이 토글 즉시 저장된다 — `enabled`
 * 토글과 같은 패턴이다.
 */

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const settingsPayload = {
  enabled: true,
  botToken: '123456:••••••••',
  hasToken: true,
  allowedChatIds: [12345678],
  fromEnvironment: false,
  running: false,
  botUsername: null,
  permissionMode: 'ask',
  notifyOnCompletion: false,
};

const saveSettings = vi.fn(async (updates: Record<string, unknown>) =>
  jsonResponse({ ...settingsPayload, ...updates }));

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');

  return {
    ...actual,
    api: {
      user: {
        preferences: async () => jsonResponse({ preferences: {} }),
        savePreferences: async () => jsonResponse({}),
        drafts: async () => jsonResponse({}),
        saveDraft: async () => jsonResponse({}),
        deleteDraft: async () => jsonResponse({}),
      },
      telegram: {
        settings: async () => jsonResponse(settingsPayload),
        saveSettings: (updates: unknown) => saveSettings(updates as Record<string, unknown>),
        test: async () => jsonResponse({ ok: true, botUsername: 'my_bot' }),
      },
    },
  };
});

beforeEach(() => {
  saveSettings.mockClear();
});

test('처음에는 완료 알림이 꺼져 있다', async () => {
  render(React.createElement(TelegramTab));

  const toggle = await screen.findByRole('switch', { name: '완료 알림' });
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
});

test('누르면 즉시 저장되고(저장 버튼 없이) 켜진 상태로 바뀐다', async () => {
  render(React.createElement(TelegramTab));

  const toggle = await screen.findByRole('switch', { name: '완료 알림' });
  fireEvent.click(toggle);

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));
  assert.deepEqual(saveSettings.mock.calls[0]![0], { notifyOnCompletion: true });

  await waitFor(() => assert.equal(toggle.getAttribute('aria-checked'), 'true'));
});
