import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';
import { addQuietFolder, readQuietFolders } from '@/shared/quietFolders';
import { resetUserPreferences } from '@/shared/userSettings';
import SidebarProjectList from '@/modules/sidebar/SidebarProjectList';

/**
 * 자동 실행 스크립트가 날짜마다 새 폴더에서 CLI 를 돌리면 사이드바가 그 폴더들로
 * 덮인다. 조용한 폴더 아래 프로젝트는 목록 맨 끝 접힌 묶음 하나로 가고, 펼쳐도
 * 안쪽 세션 때문에 점이 찍히지 않아야 한다.
 */

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const makeProject = (projectId: string, fullPath: string, sessionId: string) => ({
  projectId,
  displayName: projectId,
  fullPath,
  sessionMeta: { total: 1, hasMore: false },
  sessions: [{ id: sessionId, __provider: 'claude' }],
}) as unknown as Project;

const REGULAR = makeProject('liberty-life', '/work/liberty-life', 'regular-session');
const QUIET = makeProject('premarket', '/work/llm-sim/runs/bt-1/2026-09-22/premarket', 'quiet-session');
const PROJECTS = [QUIET, REGULAR];

const renderList = () => render(
  React.createElement(SidebarProjectList, {
    projects: PROJECTS,
    filteredProjects: PROJECTS,
    selectedProject: null,
    selectedSession: null,
    isLoading: false,
    loadingProgress: null,
    expandedProjects: new Set<string>(),
    initialSessionsLoaded: new Set<string>(),
    currentTime: new Date('2026-10-03T12:00:00.000Z'),
    deletingProjects: new Set<string>(),
    tasksEnabled: false,
    mcpServerStatus: null,
    getProjectSessions: (project: Project) => project.sessions as never,
    getProjectLastActivity: () => '',
    hasHiddenProviders: false,
    onLoadMoreSessions: noop,
    loadingMoreProjects: new Set<string>(),
    isProjectStarred: () => false,
    onToggleProject: noop,
    onProjectSelect: noop,
    onToggleStarProject: noop,
    onStartEditingProject: noop,
    onCancelEditingProject: noop,
    onSaveProjectName: noop,
    onOpenProjectSettings: noop,
    onSessionSelect: noop,
    onNewSession: noop,
    activeRename: null,
    activeSessions: new Set<string>(),
    // 두 프로젝트 모두 확인할 답이 있는 상태로 둔다.
    attentionSessionIds: new Set<string>(['regular-session', 'quiet-session']),
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onDeleteSession: noop,
    t,
  }),
);

const ATTENTION_LABEL = '이 프로젝트에 확인할 대화가 있습니다';

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

test('조용한 폴더가 없으면 묶음 머리글도 없다', () => {
  const { queryByText, getAllByText } = renderList();

  assert.equal(queryByText('Quiet folders'), null);
  assert.ok(getAllByText('premarket').length > 0);
});

test('조용한 프로젝트는 접힌 묶음 하나로 목록 맨 끝에 간다', () => {
  addQuietFolder('/work/llm-sim/runs');
  const { container, getByText, queryAllByText } = renderList();

  const header = getByText('Quiet folders').closest('button');
  assert.ok(header);
  // 그룹 만들기 버튼까지 포함해 마지막 요소다.
  assert.equal(container.firstElementChild?.lastElementChild, header);
  assert.equal(header?.textContent?.includes('1'), true);
  assert.equal(queryAllByText('premarket').length, 0);
});

test('펼쳐도 조용한 프로젝트에는 점이 찍히지 않는다', () => {
  const countDots = (container: HTMLElement) => (
    container.querySelectorAll(`[aria-label="${ATTENTION_LABEL}"]`).length
  );

  // 기준: 조용한 폴더가 없으면 두 프로젝트 모두 점을 단다.
  const baseline = renderList();
  const dotsForBothProjects = countDots(baseline.container);
  baseline.unmount();
  assert.ok(dotsForBothProjects > 0);

  addQuietFolder('/work/llm-sim/runs');
  const { getByText, getAllByText, container } = renderList();
  act(() => {
    fireEvent.click(getByText('Quiet folders'));
  });

  assert.equal(readQuietFolders().expanded, true);
  assert.ok(getAllByText('premarket').length > 0);
  // 일반 프로젝트 몫의 점만 남는다.
  assert.equal(countDots(container), dotsForBothProjects / 2);
});
