import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';

/**
 * 프로젝트 행의 두 번째 줄에는 한동안 `...ri/proj/vscode/.claude` 처럼 중간이
 * 잘린 경로가 늘 붙어 있었다. 그 자리에 지금은 마지막 대화 시각이 온다.
 *
 * 경로 자체를 못 보게 만든 것은 아니다 — 이름이 같은 프로젝트를 구분하려면
 * 결국 경로가 필요하므로, 전체 경로는 행의 툴팁으로 남는다.
 */

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};
const NOW = new Date('2026-09-05T12:00:00.000Z');

const PROJECT = {
  projectId: 'p',
  displayName: 'work6',
  fullPath: '/private/tmp/claude-501/long/path/scratchpad/work6',
  sessionMeta: { total: 4, hasMore: false },
  sessions: [],
} as unknown as Project;

const renderRow = (lastActivity: string) => render(
  React.createElement(SidebarProjectItem, {
    project: PROJECT,
    selectedProject: null,
    selectedSession: null,
    isExpanded: false,
    isDeleting: false,
    isStarred: false,
    isEditing: false,
    renameDraft: '',
    sessions: [],
    lastActivity,
    hasHiddenProviders: false,
    initialSessionsLoaded: false,
    isLoadingMoreSessions: false,
    currentTime: NOW,
    sessionRenameId: null,
    sessionRenameDraft: '',
    tasksEnabled: false,
    mcpServerStatus: null,
    onRenameDraftChange: noop,
    onToggleProject: noop,
    onProjectSelect: noop,
    onToggleStarProject: noop,
    onCancelEditingProject: noop,
    onSaveProjectName: noop,
    onOpenProjectSettings: noop,
    onDeleteProject: noop,
    onSessionSelect: noop,
    onDeleteSession: noop,
    onLoadMoreSessions: noop,
    activeSessions: new Set<string>(),
    attentionSessionIds: new Set<string>(),
    onNewSession: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    t,
  }),
);

test('행에 잘린 경로를 그리지 않는다', () => {
  const { container } = renderRow('2026-09-05T10:00:00.000Z');

  assert.equal(container.textContent?.includes('...'), false);
  assert.equal(container.textContent?.includes('scratchpad'), false);
});

test('전체 경로는 행 툴팁으로 남는다', () => {
  const { container } = renderRow('2026-09-05T10:00:00.000Z');
  const row = container.querySelector('button[title]');

  assert.equal(row?.getAttribute('title'), PROJECT.fullPath);
});

test('대화 개수는 프로젝트 이름과 같은 줄에 온다', () => {
  const { container } = renderRow('2026-09-05T10:00:00.000Z');
  const nameRow = container.querySelector('[title="4 sessions"]')?.parentElement;

  assert.equal(nameRow?.textContent?.includes(PROJECT.displayName), true);
  assert.equal(nameRow?.textContent?.includes('4'), true);
});

test('둘째 줄에는 개수 없이 마지막 대화 시각만 남는다', () => {
  const { container } = renderRow('2026-09-05T10:00:00.000Z');

  // 경과 시간 · 절대 시각. 그 앞에 개수가 붙던 `4 · 2hr` 형태는 사라졌다.
  assert.doesNotMatch(container.textContent ?? '', /4\s*·\s*2hr/);
  assert.match(container.textContent ?? '', /2hr\s*·\s*2026-09-05/);
});

test('시각을 모르면 개수만 남는다', () => {
  const { container } = renderRow('');

  assert.equal(container.textContent?.includes('·'), false);
  assert.equal(container.textContent?.includes('4'), true);
});
