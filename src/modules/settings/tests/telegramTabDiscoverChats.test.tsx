import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import TelegramTab from '@/modules/settings/tabs/TelegramTab';

/**
 * "내 chat id 찾기"가 화면에서 해야 하는 일.
 *
 * 화이트리스트가 비면 브리지가 켜지지 않는데, 자기 chat id 를 알아낼 방법이
 * 없으면 사용자는 기능을 아예 쓰지 못한다. 그래서 (1) 목록에서 눌러 바로
 * 넣을 수 있어야 하고, (2) 목록이 비었을 때 "봇에게 먼저 말을 걸라"는 안내가
 * 보여야 하며, (3) 브리지가 켜져 있어서 못 읽은 경우에는 그와 다른 안내가
 * 나와야 한다. 셋을 헷갈리면 사용자는 같은 버튼만 계속 누르게 된다.
 */

const MASKED_TOKEN = '123456:••••••••';

const state = vi.hoisted(() => ({
  settings: {
    enabled: true,
    botToken: '123456:••••••••',
    hasToken: true,
    allowedChatIds: [12345678],
    fromEnvironment: false,
    running: false,
    botUsername: null as string | null,
  },
  discovery: {
    chats: [] as Array<Record<string, unknown>>,
    bridgeRunning: false,
  },
}));

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const discoverChats = vi.hoisted(() => vi.fn());

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
        settings: async () => jsonResponse(state.settings),
        saveSettings: async () => jsonResponse(state.settings),
        test: async () => jsonResponse({ ok: true, botUsername: 'my_bot' }),
        discoverChats: () => {
          discoverChats();
          return Promise.resolve(jsonResponse(state.discovery));
        },
      },
    },
  };
});

beforeEach(() => {
  discoverChats.mockClear();
  state.settings = {
    enabled: true,
    botToken: MASKED_TOKEN,
    hasToken: true,
    allowedChatIds: [12345678],
    fromEnvironment: false,
    running: false,
    botUsername: null,
  };
  state.discovery = { chats: [], bridgeRunning: false };
});

const clickDiscover = async () => {
  const button = await screen.findByRole('button', { name: '내 chat id 찾기' });
  fireEvent.click(button);
};

test('찾은 대화를 누르면 chat id 가 목록에 들어가고, 이미 있으면 다시 넣지 않는다', async () => {
  state.discovery = {
    chats: [
      { chatId: 99999999, name: '홍길동', username: 'gildong', lastText: '안녕', isGroup: false },
      { chatId: 12345678, name: '이미있음', username: '', lastText: '테스트', isGroup: false },
    ],
    bridgeRunning: false,
  };

  render(React.createElement(TelegramTab));
  await screen.findByLabelText('봇 토큰');
  await clickDiscover();

  await waitFor(() => assert.equal(discoverChats.mock.calls.length, 1));

  // 이름·username·chatId·마지막 메시지가 모두 보인다.
  await screen.findByText('홍길동');
  await screen.findByText('@gildong');
  await screen.findByText('안녕');

  fireEvent.click(await screen.findByRole('button', { name: 'chat id 99999999 추가' }));

  // 화이트리스트 칩으로 들어온다(삭제 버튼의 aria-label 로 확인).
  await screen.findByRole('button', { name: 'chat id 99999999 삭제' });

  // 이미 화이트리스트에 있는 것을 누르면 안내만 나오고 중복으로 늘지 않는다.
  fireEvent.click(await screen.findByRole('button', { name: 'chat id 12345678 추가' }));
  await screen.findByText('이미 추가된 chat id 입니다.');
  assert.equal(screen.getAllByRole('button', { name: 'chat id 12345678 삭제' }).length, 1);
});

test('결과가 비어 있으면 봇에게 먼저 말을 걸라고 안내한다', async () => {
  render(React.createElement(TelegramTab));
  await screen.findByLabelText('봇 토큰');
  await clickDiscover();

  await screen.findByText('봇에게 아무 메시지나 먼저 보낸 뒤 다시 눌러 주세요.');
});

test('브리지가 실행 중이면 토글을 끄라고 안내한다', async () => {
  state.discovery = { chats: [], bridgeRunning: true };

  render(React.createElement(TelegramTab));
  await screen.findByLabelText('봇 토큰');
  await clickDiscover();

  await screen.findByText('브리지가 실행 중이라 목록을 읽을 수 없습니다. 위 토글을 잠시 끄고 다시 시도해 주세요.');

  // 이때의 빈 목록은 "아무도 말을 걸지 않았다"는 뜻이 아니므로 그 안내는 없어야 한다.
  assert.equal(screen.queryByText('봇에게 아무 메시지나 먼저 보낸 뒤 다시 눌러 주세요.'), null);
});

test('저장된 토큰이 없으면 버튼이 꺼지고 이유가 보인다', async () => {
  state.settings = { ...state.settings, botToken: '', hasToken: false };

  render(React.createElement(TelegramTab));
  await screen.findByLabelText('봇 토큰');

  const button = await screen.findByRole('button', { name: '내 chat id 찾기' }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  await screen.findByText('봇 토큰을 먼저 저장해야 chat id 를 찾을 수 있습니다.');

  fireEvent.click(button);
  assert.equal(discoverChats.mock.calls.length, 0);
});
