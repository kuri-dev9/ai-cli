import { useCallback, useSyncExternalStore } from 'react';

import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

/**
 * 사이드바에서만 존재하는 프로젝트 묶음.
 *
 * 디스크에는 아무것도 만들지 않는다 — 프로젝트를 어디에 두었는지만 사용자
 * 환경설정에 기록해서, 목록이 길어졌을 때 화면에서만 접어둘 수 있게 한다.
 * 환경설정에 사는 덕분에 다른 기기에서 열어도 같은 묶음이 보인다.
 */
export type ProjectGroup = {
  id: string;
  name: string;
  /** 접힌 상태도 같이 저장한다 — 매번 다시 접게 만들 이유가 없다. */
  collapsed: boolean;
};

export type ProjectGroupsState = {
  /** 화면에 그려지는 순서 그대로. */
  groups: ProjectGroup[];
  /** projectId → groupId. 여기 없는 프로젝트는 미분류다. */
  assignments: Record<string, string>;
};

const PREFERENCE_KEY = 'projectGroups';

const EMPTY_STATE: ProjectGroupsState = { groups: [], assignments: {} };

/** 정규화 결과 캐시. `useSyncExternalStore`가 같은 값에 같은 참조를 받아야 한다. */
let cachedRaw: unknown;
let cachedState: ProjectGroupsState = EMPTY_STATE;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

function normalize(raw: unknown): ProjectGroupsState {
  if (!isRecord(raw) || !Array.isArray(raw.groups)) {
    return EMPTY_STATE;
  }

  const groups: ProjectGroup[] = [];
  const seen = new Set<string>();
  for (const entry of raw.groups) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    groups.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : '',
      collapsed: entry.collapsed === true,
    });
  }

  const assignments: Record<string, string> = {};
  if (isRecord(raw.assignments)) {
    for (const [projectId, groupId] of Object.entries(raw.assignments)) {
      // 사라진 그룹을 가리키는 배정은 버린다. 그 프로젝트는 미분류로 돌아간다.
      if (typeof groupId === 'string' && seen.has(groupId)) {
        assignments[projectId] = groupId;
      }
    }
  }

  return { groups, assignments };
}

function readState(): ProjectGroupsState {
  const raw = readUserPreference<unknown>(PREFERENCE_KEY, null);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedState = normalize(raw);
  }
  return cachedState;
}

function writeState(next: ProjectGroupsState): void {
  writeUserPreference(PREFERENCE_KEY, next);
}

/** 브라우저마다 충돌하지 않을 정도면 충분한 id. */
function createGroupId(): string {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 프로젝트를 그룹별로 나눈다.
 *
 * 그룹에 속하지 않은 프로젝트는 `ungrouped`로 따로 돌려준다 — 그룹을 하나도
 * 만들지 않은 사용자에게는 이 목록이 곧 기존 화면이다.
 */
export function partitionProjectsByGroup<T extends { projectId: string }>(
  projects: T[],
  state: ProjectGroupsState,
): { ungrouped: T[]; byGroup: Map<string, T[]> } {
  const byGroup = new Map<string, T[]>();
  for (const group of state.groups) {
    byGroup.set(group.id, []);
  }

  const ungrouped: T[] = [];
  for (const project of projects) {
    const groupId = state.assignments[project.projectId];
    const bucket = groupId ? byGroup.get(groupId) : undefined;
    if (bucket) {
      bucket.push(project);
    } else {
      ungrouped.push(project);
    }
  }

  return { ungrouped, byGroup };
}

/** 사이드바가 쓰는 그룹 상태와 조작 함수들. */
export function useProjectGroups() {
  const state = useSyncExternalStore(subscribeToUserPreferences, readState, readState);

  const createGroup = useCallback((name: string): string => {
    const id = createGroupId();
    const current = readState();
    writeState({
      ...current,
      groups: [...current.groups, { id, name: name.trim(), collapsed: false }],
    });
    return id;
  }, []);

  const renameGroup = useCallback((groupId: string, name: string): void => {
    const current = readState();
    writeState({
      ...current,
      groups: current.groups.map((group) => (
        group.id === groupId ? { ...group, name: name.trim() } : group
      )),
    });
  }, []);

  /** 그룹만 없앤다. 안에 있던 프로젝트는 미분류로 돌아갈 뿐 지워지지 않는다. */
  const deleteGroup = useCallback((groupId: string): void => {
    const current = readState();
    const assignments: Record<string, string> = {};
    for (const [projectId, assigned] of Object.entries(current.assignments)) {
      if (assigned !== groupId) {
        assignments[projectId] = assigned;
      }
    }
    writeState({
      groups: current.groups.filter((group) => group.id !== groupId),
      assignments,
    });
  }, []);

  const toggleGroupCollapsed = useCallback((groupId: string): void => {
    const current = readState();
    writeState({
      ...current,
      groups: current.groups.map((group) => (
        group.id === groupId ? { ...group, collapsed: !group.collapsed } : group
      )),
    });
  }, []);

  /** `groupId`가 null이면 미분류로 내보낸다. */
  const assignProject = useCallback((projectId: string, groupId: string | null): void => {
    const current = readState();
    const assignments = { ...current.assignments };
    if (groupId) {
      assignments[projectId] = groupId;
    } else {
      delete assignments[projectId];
    }
    writeState({ ...current, assignments });
  }, []);

  const moveGroup = useCallback((groupId: string, direction: -1 | 1): void => {
    const current = readState();
    const index = current.groups.findIndex((group) => group.id === groupId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= current.groups.length) {
      return;
    }

    const groups = [...current.groups];
    [groups[index], groups[target]] = [groups[target], groups[index]];
    writeState({ ...current, groups });
  }, []);

  return {
    groups: state.groups,
    assignments: state.assignments,
    createGroup,
    renameGroup,
    deleteGroup,
    toggleGroupCollapsed,
    assignProject,
    moveGroup,
  };
}
