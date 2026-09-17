import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';
import React from 'react';

import '@/modules/i18n';
import { QuickSettingsContent, useTelegramSessionNotifications } from '@/modules/quick-settings-panel';
import type { TelegramSessionNotificationsState } from '@/modules/quick-settings-panel';
import { ThemeProvider } from '@/shared/context/ThemeContext';
import type { QuickSettingsPreferences } from '@/shared/types';

/**
 * "이 세션 작업 알림 받기" 토글.
 *
 * 두 가지를 지킨다. 하나, 켜 둔 값은 서버에 남아야 한다 — 브라우저에만 두면
 * 서버가 재시작하거나 다른 기기에서 열었을 때 화면과 실제 동작이 어긋나는데,
 * 알림은 어긋난 것을 알아채기 가장 어려운 기능이다. 둘, 브리지가 붙어 있지
 * 않으면 잠그고 이유를 보여 준다 — 켤 수는 있는데 아무것도 오지 않는 상태가
 * 가장 나쁘다.
 */

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

const sessionNotifications = vi.fn(async (_sessionId: string) => jsonResponse({
  sessionId: 'session-1',
  enabled: false,
  available: true,
  hasToken: true,
  bridgeEnabled: true,
}));

const saveSessionNotifications = vi.fn(async (sessionId: string, enabled: boolean) => jsonResponse({
  sessionId,
  enabled,
  available: true,
  hasToken: true,
  bridgeEnabled: true,
}));

vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/shared/api');

  return {
    ...actual,
    api: {
      // i18n 이 언어를 저장할 때 건드리는 경로. 막아 두지 않으면 목에 없는
      // `api.user` 를 부르다 테스트가 죽는다.
      user: {
        preferences: async () => jsonResponse({ preferences: {} }),
        savePreferences: async () => jsonResponse({}),
      },
      telegram: {
        sessionNotifications: (sessionId: string) => sessionNotifications(sessionId),
        saveSessionNotifications: (sessionId: string, enabled: boolean) =>
          saveSessionNotifications(sessionId, enabled),
      },
    },
  };
});

const preferences: QuickSettingsPreferences = {
  showRawParameters: false,
  showThinking: false,
  sendByCtrlEnter: false,
  voiceEnabled: false,
};

const telegramState = (
  overrides: Partial<TelegramSessionNotificationsState> = {},
): TelegramSessionNotificationsState => ({
  enabled: false,
  available: true,
  hasToken: true,
  bridgeEnabled: true,
  isLoading: false,
  setEnabled: () => {},
  ...overrides,
});

function renderPanel(
  activeSessionId: string | null,
  telegram: TelegramSessionNotificationsState,
) {
  return render(
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(QuickSettingsContent, {
        isDarkMode: false,
        preferences,
        onPreferenceChange: () => {},
        activeSessionId,
        telegramNotifications: telegram,
      }),
    ),
  );
}

test('브리지가 붙어 있으면 토글을 켤 수 있다', async () => {
  const setEnabled = vi.fn();
  renderPanel('session-1', telegramState({ setEnabled }));

  const toggle = await screen.findByLabelText('이 세션 작업 알림 받기') as HTMLInputElement;
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.checked, false);

  fireEvent.click(toggle);
  assert.deepEqual(setEnabled.mock.calls, [[true]]);
});

test('토큰이 없으면 잠그고 이유를 보여 준다', async () => {
  renderPanel('session-1', telegramState({ hasToken: false, available: false }));

  const toggle = await screen.findByLabelText('이 세션 작업 알림 받기') as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  assert.ok(document.body.textContent?.includes('봇 토큰을 먼저 저장'));
});

test('브리지가 연결되지 않았으면 잠근다', async () => {
  renderPanel('session-1', telegramState({ available: false }));

  const toggle = await screen.findByLabelText('이 세션 작업 알림 받기') as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  assert.ok(document.body.textContent?.includes('연결되지 않았습니다'));
});

test('열린 세션이 없으면 켤 수 없다', async () => {
  renderPanel(null, telegramState());

  const toggle = await screen.findByLabelText('이 세션 작업 알림 받기') as HTMLInputElement;
  assert.equal(toggle.disabled, true);
  assert.ok(document.body.textContent?.includes('세션을 연 뒤에'));
});

test('토글은 세션 단위로 서버에 저장된다', async () => {
  const { result } = renderHook(() => useTelegramSessionNotifications('session-1'));

  await waitFor(() => {
    assert.equal(result.current.isLoading, false);
  });
  assert.deepEqual(sessionNotifications.mock.calls.at(-1), ['session-1']);
  assert.equal(result.current.enabled, false);

  act(() => {
    result.current.setEnabled(true);
  });

  await waitFor(() => {
    assert.equal(result.current.enabled, true);
  });
  assert.deepEqual(saveSessionNotifications.mock.calls.at(-1), ['session-1', true]);
});
