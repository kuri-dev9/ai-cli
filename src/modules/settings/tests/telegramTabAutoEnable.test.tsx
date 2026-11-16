import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import TelegramTab from '@/modules/settings/tabs/TelegramTab';

/**
 * chat id 를 등록하면 브리지를 같이 켠다.
 *
 * "내 chat id 찾기"는 브리지를 꺼야 쓸 수 있다. 찾아서 등록하고 저장한 뒤
 * 다시 켜는 걸 잊으면, 연결은 다 해 놓고도 아무것도 오지 않는다. 그래서 새
 * chat id 를 저장할 때 꺼져 있으면 함께 켜고, 켰다는 안내를 남긴다.
 */

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));

const saveSettings = vi.hoisted(() => vi.fn());

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
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
      telegram: {
        settings: async () => jsonResponse(state.settings),
        saveSettings: async (updates: Record<string, unknown>) => {
          saveSettings(updates);
          state.settings = { ...state.settings, ...updates, running: updates.enabled === true };
          return jsonResponse(state.settings);
        },
      },
    },
  };
});

beforeEach(() => {
  saveSettings.mockClear();
  state.settings = {
    enabled: false,
    botToken: '123456:••••••••',
    hasToken: true,
    allowedChatIds: [],
    fromEnvironment: false,
    running: false,
    botUsername: null,
    permissionMode: 'ask',
    notifyOnCompletion: false,
  };
});

const addChatIdAndSave = async (chatId: string) => {
  const input = await screen.findByPlaceholderText('예: 12345678 (쉼표로 여러 개)');
  fireEvent.change(input, { target: { value: chatId } });
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
};

test('꺼진 브리지에 새 chat id 를 저장하면 브리지를 켜고 알린다', async () => {
  render(React.createElement(TelegramTab));
  await addChatIdAndSave('12345678');

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));
  assert.deepEqual(saveSettings.mock.calls[0][0], { allowedChatIds: [12345678], enabled: true });
  await screen.findByText('chat id 를 등록해서 텔레그램 브리지를 켰습니다. 이제 봇에게 메시지를 보내 보세요.');
  await screen.findByText('연결됨');
});

test('이미 켜져 있으면 enabled 를 건드리지 않고 안내도 없다', async () => {
  state.settings = { ...state.settings, enabled: true, running: true, allowedChatIds: [111] };
  render(React.createElement(TelegramTab));
  await addChatIdAndSave('12345678');

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));
  assert.deepEqual(saveSettings.mock.calls[0][0], { allowedChatIds: [111, 12345678] });
  assert.equal(screen.queryByRole('status'), null);
});

test('chat id 를 지우기만 한 저장은 꺼 둔 브리지를 켜지 않는다', async () => {
  state.settings = { ...state.settings, allowedChatIds: [111, 222] };
  render(React.createElement(TelegramTab));

  fireEvent.click(await screen.findByRole('button', { name: 'chat id 222 삭제' }));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));
  assert.deepEqual(saveSettings.mock.calls[0][0], { allowedChatIds: [111] });
});
