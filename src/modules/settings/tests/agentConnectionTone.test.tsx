import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import React from 'react';

import '@/modules/i18n';
import AccountContent from '@/modules/settings/tabs/agents-settings/sections/content/AccountContent';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';

/** 테스트가 로케일에 매이지 않게, 카드 제목과 배지는 두 언어를 다 받아 준다. */
const CONNECTION_STATUS_TITLE = /^(Connection Status|연결 상태)$/;
const CONNECTED_BADGE = /^(Connected|연결됨)$/;

/**
 * 연결 카드의 색.
 *
 * 예전에는 CLI 마다 고유색이었다 — Claude 는 파랑, Codex 는 회색. 탭을 옮길 때마다
 * 색이 바뀌니 "이쪽은 연결이 다른가" 로 읽혔다. 색이 말해야 하는 것은 어느 CLI
 * 인지가 아니라 지금 연결이 어떤 상태인지다.
 */

const authStatus = (overrides: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus => ({
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
  ...overrides,
});

const renderConnectionCard = (agent: AgentProvider, status: ProviderAuthStatus) => {
  const view = render(
    <AccountContent agent={agent} authStatus={status} onLogin={() => {}} />,
  );
  const card = screen.getByText(CONNECTION_STATUS_TITLE).closest('div.rounded-lg');
  const className = card?.className ?? '';
  view.unmount();
  return className;
};

test('같은 연결 상태면 CLI 가 달라도 같은 색으로 그린다', () => {
  const connected = authStatus({ authenticated: true, email: 'someone@example.com' });

  expect(renderConnectionCard('claude', connected)).toBe(renderConnectionCard('codex', connected));
  expect(renderConnectionCard('cursor', authStatus())).toBe(renderConnectionCard('opencode', authStatus()));
});

test('연결·끊김·이상은 서로 다른 색으로 그린다', () => {
  const connected = renderConnectionCard('claude', authStatus({ authenticated: true }));
  const disconnected = renderConnectionCard('claude', authStatus());
  const broken = renderConnectionCard('claude', authStatus({ authenticated: true, error: 'CLI not found' }));

  expect(new Set([connected, disconnected, broken]).size).toBe(3);
});

test('연결 배지는 상태를 그대로 말한다', () => {
  render(
    <AccountContent
      agent="claude"
      authStatus={authStatus({ authenticated: true, email: 'someone@example.com' })}
      onLogin={() => {}}
    />,
  );

  const card = screen.getByText(CONNECTION_STATUS_TITLE).closest('div.rounded-lg') as HTMLElement;
  expect(within(card).getByText(CONNECTED_BADGE)).toBeTruthy();
});
