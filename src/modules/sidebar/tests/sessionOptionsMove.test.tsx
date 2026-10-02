import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { LLMProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * "Move to project" is offered exactly where a move can succeed: a provider
 * that can fork (Claude, Codex) and a session that is not mid-run. The menu is
 * stubbed so the test reads the items SessionOptions builds.
 */

const recordedMenuItems: Array<Array<{ key: string; onSelect?: () => void }>> = [];

vi.mock('@/shared/ui', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ActionMenu: (props: { items: Array<{ key: string; onSelect?: () => void }> }) => {
    recordedMenuItems.push(props.items);
    return null;
  },
}));

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set<LLMProvider>(['claude', 'codex']),
}));

const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const renderOptions = (overrides: Partial<React.ComponentProps<typeof SessionOptions>> = {}) => render(
  <SessionOptions
    sessionId="s1"
    sessionName="A session"
    provider="claude"
    projectId="p1"
    isProcessing={false}
    isEditing={false}
    renameDraft=""
    onRenameDraftChange={noop}
    onStartEditingSession={noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onDeleteSession={noop}
    t={t}
    {...overrides}
  />,
);

const itemKeys = () => (recordedMenuItems.at(-1) ?? []).map((item) => item.key);

beforeEach(() => {
  recordedMenuItems.length = 0;
});

test('a Claude or Codex session offers the move and runs the bound callback', () => {
  let moved = 0;
  renderOptions({ onMove: () => { moved += 1; } });

  const move = recordedMenuItems.at(-1)?.find((item) => item.key === 'move');
  assert.ok(move);
  move.onSelect?.();
  assert.equal(moved, 1);

  renderOptions({ provider: 'codex', onMove: noop });
  assert.ok(itemKeys().includes('move'));
});

test('no move for a provider that cannot fork', () => {
  renderOptions({ provider: 'cursor', onMove: noop });
  assert.ok(!itemKeys().includes('move'));
});

test('no move while the session is running', () => {
  renderOptions({ isProcessing: true, onMove: noop });
  assert.ok(!itemKeys().includes('move'));
});

test('no move where the caller did not wire one', () => {
  renderOptions();
  assert.ok(!itemKeys().includes('move'));
});
