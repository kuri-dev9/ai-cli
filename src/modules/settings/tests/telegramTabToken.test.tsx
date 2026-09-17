import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import TelegramTab from '@/modules/settings/tabs/TelegramTab';

/**
 * 텔레그램 설정 탭이 지켜야 하는 두 가지.
 *
 * 하나, 저장된 봇 토큰은 화면에 평문으로 나오면 안 된다. 서버는 마스킹된 값만
 * 주므로 화면이 그것을 그대로 두기만 하면 되는데, 입력칸에 채워 넣는 순간
 * "저장을 누르면 그 값이 다시 올라가는" 문제가 생긴다.
 *
 * 둘, 토큰 입력칸을 건드리지 않았으면 PUT 페이로드에 `botToken` 이 아예 없어야
 * 한다. 마스킹된 값을 되돌려 보내면 서버가 걸러 주긴 하지만, 그 방어에 기대면
 * 서버가 조금만 달라져도 멀쩡한 토큰이 점 여덟 개로 덮인다.
 */

const MASKED_TOKEN = '123456:••••••••';

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const settingsPayload = {
  enabled: true,
  botToken: MASKED_TOKEN,
  hasToken: true,
  allowedChatIds: [12345678],
  fromEnvironment: false,
  running: false,
  botUsername: null,
};

const saveSettings = vi.fn(async (_updates: Record<string, unknown>) => jsonResponse(settingsPayload));

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');

  return {
    ...actual,
    api: {
      // i18n 설정이 언어를 저장할 때 건드리는 경로. 여기서 막아 두지 않으면
      // 목 객체에 없는 `api.user` 를 부르다 테스트가 죽는다.
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

test('저장된 토큰은 마스킹된 채로만 보이고 입력칸에는 채워지지 않는다', async () => {
  render(React.createElement(TelegramTab));

  const tokenInput = await screen.findByLabelText('봇 토큰') as HTMLInputElement;

  // 비밀번호 입력칸이고, 값은 비어 있다. 마스킹 값은 placeholder 로만 보인다.
  assert.equal(tokenInput.type, 'password');
  assert.equal(tokenInput.value, '');
  assert.equal(tokenInput.placeholder, MASKED_TOKEN);

  // 평문 토큰(마스킹 전의 `:` 뒷자리)은 화면 어디에도 없다.
  assert.equal(document.body.textContent?.includes('AAHfake'), false);
  assert.equal(document.body.innerHTML.includes('•'.repeat(8)) || tokenInput.placeholder === MASKED_TOKEN, true);
});

test('토큰 입력칸을 건드리지 않으면 저장 페이로드에 botToken 이 없다', async () => {
  render(React.createElement(TelegramTab));

  await screen.findByLabelText('봇 토큰');

  // chat id 만 하나 추가하고 저장한다.
  fireEvent.change(screen.getByPlaceholderText('예: 12345678 (쉼표로 여러 개)'), {
    target: { value: '99999999' },
  });
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));

  const payload = saveSettings.mock.calls[0]![0];
  assert.equal('botToken' in payload, false);
  assert.deepEqual(payload.allowedChatIds, [12345678, 99999999]);
});

test('토큰을 입력했을 때에만 botToken 이 실린다', async () => {
  render(React.createElement(TelegramTab));

  const tokenInput = await screen.findByLabelText('봇 토큰');
  fireEvent.change(tokenInput, { target: { value: '987654:NEWTOKEN' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => assert.equal(saveSettings.mock.calls.length, 1));

  const payload = saveSettings.mock.calls[0]![0];
  assert.equal(payload.botToken, '987654:NEWTOKEN');
});
