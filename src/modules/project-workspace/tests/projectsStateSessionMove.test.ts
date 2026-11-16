import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * 대화를 다른 프로젝트로 옮기면 원래 프로젝트 목록에서 사라져야 한다.
 *
 * 서버는 세션 id 를 그대로 둔 채 경로만 바꾼다. 사이드바가 새 프로젝트에 넣기만
 * 하고 원래 프로젝트에서 빼지 않으면 양쪽에 다 보이고, 이동을 시킨 화면은
 * 새로고침 병합이 예전 목록을 다시 합쳐 원래 프로젝트에 되살렸다.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

type ServerEventListener = (event: Record<string, unknown>) => void;
const listeners = new Set<ServerEventListener>();
const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const session = (id: string): ProjectSession => ({ id, summary: id } as ProjectSession);

const buildProject = (projectId: string, sessions: ProjectSession[], hasMore = false): Project => ({
  projectId,
  path: `/${projectId}`,
  fullPath: `/${projectId}`,
  displayName: projectId,
  isStarred: false,
  sessions,
  sessionMeta: { hasMore, total: sessions.length + (hasMore ? 10 : 0) },
});

const respondWith = (projects: Project[]) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
};

const renderProjectsState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn() as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

const sessionIdsOf = (projects: Project[], projectId: string) =>
  (projects.find((project) => project.projectId === projectId)?.sessions ?? []).map((entry) => entry.id);

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('다른 프로젝트로 옮겼다는 알림을 받으면 원래 프로젝트 목록에서 뺀다', async () => {
  respondWith([
    buildProject('a', [session('moved'), session('stays')]),
    buildProject('b', []),
  ]);
  const { result } = await renderProjectsState();
  await waitFor(() => assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['moved', 'stays']));

  await act(async () => {
    emit({
      kind: 'session_upserted',
      sessionId: 'moved',
      provider: 'claude',
      session: { id: 'moved', summary: 'moved', messageCount: 0, lastActivity: '2026-11-16T00:00:00.000Z' },
      project: { projectId: 'b', path: '/b', fullPath: '/b', displayName: 'b', isStarred: false },
      timestamp: '2026-11-16T00:00:00.000Z',
    });
  });

  assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['stays']);
  assert.deepEqual(sessionIdsOf(result.current.projects, 'b'), ['moved']);
});

test('다른 기기에서 막 만든 프로젝트로 옮겨도 원래 프로젝트에서 뺀다', async () => {
  respondWith([buildProject('a', [session('moved'), session('stays')])]);
  const { result } = await renderProjectsState();
  await waitFor(() => assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['moved', 'stays']));

  await act(async () => {
    emit({
      kind: 'session_upserted',
      sessionId: 'moved',
      provider: 'claude',
      session: { id: 'moved', summary: 'moved', messageCount: 0, lastActivity: '2026-11-16T00:00:00.000Z' },
      project: { projectId: 'new', path: '/new', fullPath: '/new', displayName: 'new', isStarred: false },
      timestamp: '2026-11-16T00:00:00.000Z',
    });
  });

  assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['stays']);
  assert.deepEqual(sessionIdsOf(result.current.projects, 'new'), ['moved']);
});

test('이동 뒤 새로고침이 옮긴 세션을 원래 프로젝트에 되살리지 않는다', async () => {
  respondWith([
    buildProject('a', [session('moved'), session('stays')]),
    buildProject('b', []),
  ]);
  const { result } = await renderProjectsState();
  await waitFor(() => assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['moved', 'stays']));

  // 서버는 이제 그 세션을 B 에 둔다. A 는 하나가 줄었다.
  respondWith([
    buildProject('a', [session('stays')]),
    buildProject('b', [session('moved')]),
  ]);
  await act(async () => {
    await result.current.handleSidebarRefresh();
  });

  assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['stays']);
  assert.deepEqual(sessionIdsOf(result.current.projects, 'b'), ['moved']);
});

test('더 불러온 페이지는 새로고침 뒤에도 남지만, 다른 프로젝트로 간 세션은 빠진다', async () => {
  respondWith([
    buildProject('a', [session('moved'), session('s1'), session('older')], true),
    buildProject('b', []),
  ]);
  const { result } = await renderProjectsState();
  await waitFor(() => assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['moved', 's1', 'older']));

  // 첫 페이지만 다시 온다. 'older' 는 예전에 더 불러 둔 페이지에 있던 것이다.
  respondWith([
    buildProject('a', [session('s1')], true),
    buildProject('b', [session('moved')]),
  ]);
  await act(async () => {
    await result.current.handleSidebarRefresh();
  });

  assert.deepEqual(sessionIdsOf(result.current.projects, 'a'), ['s1', 'older']);
  assert.deepEqual(sessionIdsOf(result.current.projects, 'b'), ['moved']);
});
