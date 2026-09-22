import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import TelegramTab from '@/modules/settings/tabs/TelegramTab';

/**
 * 텔레그램 작업 권한 고르기.
 *
 * 승인 창은 브라우저에만 그려지므로, 폰에서 온 작업은 여기서 고른 만큼만 할 수
 * 있다. 그래서 두 가지가 중요하다 — 아무것도 고르지 않은 설치가 "묻기"로
 * 시작할 것, 그리고 "전부 허용"을 고를 때 무슨 일이 생기는지 화면이 말해 줄 것.
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
};

const saveSettings = vi.fn(async (_updates: Record<string, unknown>) => jsonResponse(settingsPayload));

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

test('처음에는 묻기가 골라져 있다', async () => {
  render(React.createElement(TelegramTab));

  const ask = await screen.findByRole('radio', { name: /묻기/ }) as HTMLInputElement;
  assert.equal(ask.checked, true);
});

test('고른 권한이 저장 페이로드에 실린다', async () => {
  render(React.createElement(TelegramTab));

  const readOnly = await screen.findByRole('radio', { name: /읽기만 허용/ });
  fireEvent.click(readOnly);
  fireEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));

  const payload = saveSettings.mock.calls[0]![0];
  assert.equal(payload.permissionMode, 'read');
  // 건드리지 않은 것은 싣지 않는다.
  assert.equal('botToken' in payload, false);
  assert.equal('allowedChatIds' in payload, false);
});

test('전부 허용을 고르면 무엇이 위험한지 화면이 말해 준다', async () => {
  render(React.createElement(TelegramTab));

  const full = await screen.findByRole('radio', { name: /전부 허용/ });

  // 고르기 전에는 경고가 없다. 늘 떠 있으면 읽지 않게 된다.
  assert.equal(document.body.textContent?.includes('승인 없이 실행합니다'), false);

  fireEvent.click(full);

  await waitFor(() => {
    assert.ok(document.body.textContent?.includes('승인 없이 실행합니다'));
  });
});

test('권한만 바꿔도 저장 버튼이 열린다', async () => {
  render(React.createElement(TelegramTab));

  await screen.findByRole('radio', { name: /묻기/ });
  const save = screen.getByRole('button', { name: '저장' }) as HTMLButtonElement;
  // 바꾼 것이 없으면 누를 수 없다.
  assert.equal(save.disabled, true);

  fireEvent.click(screen.getByRole('radio', { name: /전부 허용/ }));

  await waitFor(() => assert.equal(save.disabled, false));
});
