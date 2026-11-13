import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';

/**
 * 다른 프로젝트를 누르면 빈 새 세션 화면이 아니라 그 프로젝트의 가장 최근
 * 대화가 바로 열린다. 예전에는 프로젝트를 누른 뒤 세션을 한 번 더 눌러야 했다.
 */

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const PROJECT = {
  projectId: 'p',
  displayName: 'sheet-helper',
  fullPath: '/work/sheet-helper',
  sessionMeta: { total: 2, hasMore: false },
  sessions: [],
} as unknown as Project;

const OTHER_PROJECT = { ...PROJECT, projectId: 'other', displayName: 'ai-cli' } as Project;

// 사이드바는 최근 순으로 정렬한 목록을 넘긴다.
const SESSIONS = [
  { id: 'latest', summary: '어제 사본 만든거 url', __provider: 'claude' },
  { id: 'older', summary: '예전 대화', __provider: 'claude' },
] as unknown as SessionWithProvider[];

function renderRow({
  selectedProject,
  sessions,
}: {
  selectedProject: Project | null;
  sessions: SessionWithProvider[];
}) {
  const calls: string[] = [];
  const { container } = render(
    React.createElement(SidebarProjectItem, {
      project: PROJECT,
      selectedProject,
      selectedSession: null,
      isExpanded: false,
      isDeleting: false,
      isStarred: false,
      isEditing: false,
      renameDraft: '',
      sessions,
      lastActivity: '',
      hasHiddenProviders: false,
      initialSessionsLoaded: true,
      isLoadingMoreSessions: false,
      currentTime: new Date('2026-11-13T12:00:00.000Z'),
      sessionRenameId: null,
      sessionRenameDraft: '',
      tasksEnabled: false,
      mcpServerStatus: null,
      onRenameDraftChange: noop,
      onToggleProject: (projectId: string) => calls.push(`toggle:${projectId}`),
      onProjectSelect: (project: Project) => calls.push(`project:${project.projectId}`),
      onToggleStarProject: noop,
      onCancelEditingProject: noop,
      onSaveProjectName: noop,
      onOpenProjectSettings: noop,
      onSessionSelect: (session: SessionWithProvider, projectId: string) =>
        calls.push(`session:${session.id}@${projectId}`),
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
  const row = container.querySelector<HTMLButtonElement>(`button[title="${PROJECT.fullPath}"]`)!;
  return { row, calls };
}

test('다른 프로젝트를 누르면 가장 최근 대화가 바로 열린다', () => {
  const { row, calls } = renderRow({ selectedProject: OTHER_PROJECT, sessions: SESSIONS });

  fireEvent.click(row);

  assert.deepEqual(calls, ['project:p', 'session:latest@p', 'toggle:p']);
});

test('대화가 없는 프로젝트는 예전처럼 새 세션 화면이 열린다', () => {
  const { row, calls } = renderRow({ selectedProject: OTHER_PROJECT, sessions: [] });

  fireEvent.click(row);

  assert.deepEqual(calls, ['project:p', 'toggle:p']);
});

test('이미 고른 프로젝트를 다시 누르면 접고 펼치기만 한다', () => {
  const { row, calls } = renderRow({ selectedProject: PROJECT, sessions: SESSIONS });

  fireEvent.click(row);

  assert.deepEqual(calls, ['toggle:p']);
});
