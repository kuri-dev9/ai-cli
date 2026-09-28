import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { ProjectSession, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * 한 프로젝트에 세션이 쌓이면 목록 아래의 새 세션 버튼까지 내려가기가 힘들었다.
 * 그래서 최근 5개만 보여 주고 나머지는 더보기로 접는다. 다만 열려 있거나,
 * 돌고 있거나, 확인을 기다리는 세션은 오래됐어도 접지 않는다.
 */

const renderedSessionIds: string[] = [];

vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({
  default: (props: { session: SessionWithProvider }) => {
    renderedSessionIds.push(props.session.id);
    return null;
  },
}));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');

// 목록은 이미 최근순으로 정렬되어 들어온다. s1 이 가장 최근이다.
const SESSIONS = Array.from({ length: 9 }, (_, index) => ({
  id: `s${index + 1}`,
  summary: `s${index + 1}`,
  __provider: 'claude',
})) as unknown as SessionWithProvider[];

const t = ((key: string, options?: { count?: number }) => (
  options?.count === undefined ? key : `${key}:${options.count}`
)) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const NONE: ReadonlySet<string> = new Set<string>();

const renderSessions = (overrides: Partial<{
  selectedSession: ProjectSession | null;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  hasMoreSessions: boolean;
  onLoadMoreSessions: (projectId: string) => void;
}> = {}) => render(
  React.createElement(SidebarProjectSessions, {
    project: { projectId: 'p', displayName: 'p' } as never,
    isExpanded: true,
    sessions: SESSIONS,
    selectedSession: null,
    initialSessionsLoaded: true,
    hasMoreSessions: false,
    isLoadingMoreSessions: false,
    activeSessions: NONE,
    attentionSessionIds: NONE,
    currentTime: new Date('2026-09-28T00:00:00.000Z'),
    sessionRenameId: null,
    sessionRenameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    onLoadMoreSessions: noop,
    t,
    ...overrides,
  }),
);

beforeEach(() => {
  renderedSessionIds.length = 0;
});

test('최근 5개만 그리고 나머지는 더보기 개수로 남긴다', () => {
  const { getByText } = renderSessions();

  assert.deepEqual(renderedSessionIds, ['s1', 's2', 's3', 's4', 's5']);
  getByText('sessions.showOlder:4');
});

test('열린·실행 중·확인 필요 세션은 오래됐어도 최근순 자리에 남는다', () => {
  const { getByText } = renderSessions({
    selectedSession: { id: 's9' } as ProjectSession,
    activeSessions: new Set(['s7']),
    attentionSessionIds: new Set(['s6']),
  });

  assert.deepEqual(renderedSessionIds, ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's9']);
  getByText('sessions.showOlder:1');
});

test('더보기를 누르면 전부 펼치고, 다시 접을 수 있다', () => {
  const { getByText, queryByText } = renderSessions();

  renderedSessionIds.length = 0;
  fireEvent.click(getByText('sessions.showOlder:4'));
  assert.equal(renderedSessionIds.length, 9);
  assert.equal(queryByText('sessions.showOlder:4'), null);

  renderedSessionIds.length = 0;
  fireEvent.click(getByText('sessions.showRecentOnly'));
  assert.equal(renderedSessionIds.length, 5);
});

test('받아 둔 세션을 다 펼친 뒤에야 서버에서 더 받아 온다', () => {
  const requested: string[] = [];
  const { getByText, queryByText } = renderSessions({
    hasMoreSessions: true,
    onLoadMoreSessions: (projectId) => requested.push(projectId),
  });

  assert.equal(queryByText('sessions.showMore'), null);
  fireEvent.click(getByText('sessions.showOlder:4'));
  fireEvent.click(getByText('sessions.showMore'));
  assert.deepEqual(requested, ['p']);
});

test('목록 안에는 새 세션 버튼이 없다', () => {
  const { queryByText } = renderSessions();

  assert.equal(queryByText('sessions.newSession'), null);
});
