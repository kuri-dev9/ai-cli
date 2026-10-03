import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 프로젝트마다 플레이어 패널이 훑을 폴더 목록.
 *
 * 만들어진 음원·영상은 프로젝트 안이 아니라 도구가 쓰는 제 폴더에 쌓이는 경우가
 * 많다. 그런 폴더를 프로젝트 설정에 적어 두면 그 프로젝트를 열었을 때 오른쪽
 * 패널에서 목록을 보고 바로 들을 수 있다.
 *
 * 프로젝트 등록이 아니라 보기 방식이다. 사이드바에도, 파일 탭에도 나타나지
 * 않는다. 프로젝트별로 두는 이유는 폴더가 그 프로젝트의 작업물이기 때문이다 —
 * 다른 프로젝트를 열었을 때 남의 음원 목록이 따라다닐 이유가 없다.
 *
 * 저장은 프로젝트 그룹과 같은 모양이다: 사용자 설정(`auth.db`)에 프로젝트 id 를
 * 키로 둔 객체 하나. 기기 사이에서 따라온다.
 */

const PREFERENCE_KEY = 'mediaFolders';

const EMPTY_PATHS: string[] = [];

/** 정규화 결과 캐시. `useSyncExternalStore` 가 같은 값에 같은 참조를 받아야 한다. */
let cachedRaw: unknown;
let cachedByProject: Record<string, string[]> = {};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * 비교할 수 있는 모양으로 경로를 맞춘다. 맞출 수 없으면 빈 문자열.
 *
 * 절대 경로만 받는다. `~` 는 브라우저가 홈 디렉터리를 모르니 풀 수 없고, 상대
 * 경로는 무엇에 대한 상대인지 정할 수 없다. 루트(`/`, `C:/`)도 거절한다 —
 * 디스크 전체를 훑는 설정은 실수일 가능성이 훨씬 높다.
 */
export function normalizeMediaFolderPath(input: string): string {
  const slashed = input.trim().replace(/\\/g, '/');
  const isPosixAbsolute = slashed.startsWith('/');
  const isWindowsAbsolute = /^[A-Za-z]:\//.test(slashed);
  if (!isPosixAbsolute && !isWindowsAbsolute) {
    return '';
  }

  const collapsed = slashed.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!collapsed || /^[A-Za-z]:$/.test(collapsed)) {
    return '';
  }
  return collapsed;
}

function normalizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return EMPTY_PATHS;
  }

  const paths: string[] = [];
  for (const entry of raw) {
    const normalized = typeof entry === 'string' ? normalizeMediaFolderPath(entry) : '';
    if (normalized && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}

function readByProject(): Record<string, string[]> {
  const raw = readUserPreference<unknown>(PREFERENCE_KEY, null);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    const next: Record<string, string[]> = {};
    if (isRecord(raw)) {
      for (const [projectId, paths] of Object.entries(raw)) {
        const normalized = normalizePaths(paths);
        if (normalized.length > 0) {
          // 내용이 같으면 이전 배열을 그대로 둔다 — 이 배열에 매달린 목록 다시
          // 읽기가 다른 프로젝트의 설정을 고칠 때마다 돌지 않게 하려는 것이다.
          const previous = cachedByProject[projectId];
          const same = previous
            && previous.length === normalized.length
            && previous.every((path, index) => path === normalized[index]);
          next[projectId] = same ? previous : normalized;
        }
      }
    }
    cachedByProject = next;
  }
  return cachedByProject;
}

/** 이 프로젝트에 연결된 폴더 목록. 없으면 빈 목록이다. */
export function readMediaFolders(projectId: string | null | undefined): string[] {
  if (!projectId) {
    return EMPTY_PATHS;
  }
  return readByProject()[projectId] ?? EMPTY_PATHS;
}

/** 이 프로젝트의 폴더 목록을 통째로 바꾼다. 빈 목록이면 항목 자체를 지운다. */
export function writeMediaFolders(projectId: string, paths: readonly string[]): void {
  const current = readByProject();
  const normalized = normalizePaths(paths);
  const next = { ...current };
  if (normalized.length > 0) {
    next[projectId] = normalized;
  } else {
    delete next[projectId];
  }
  writeUserPreference(PREFERENCE_KEY, next);
}

/** 경로에서 사람이 읽을 폴더 이름만 꺼낸다. 목록 머리글에 쓴다. */
export function mediaFolderLabel(folderPath: string): string {
  return folderPath.split('/').filter(Boolean).pop() ?? folderPath;
}
