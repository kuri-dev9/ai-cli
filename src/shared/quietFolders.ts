import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 조용히 둘 폴더 목록.
 *
 * 스크립트가 날짜·단계마다 새 폴더를 만들어 가며 CLI 를 돌리면, 실행 한 번이
 * 사이드바에 프로젝트 하나로 잡힌다. 그런 폴더의 상위 경로를 여기에 적어 두면
 * 그 아래 프로젝트는 사이드바 맨 아래 묶음 하나로 모이고, 새 세션이 생겨도 위로
 * 올라오거나 점을 찍거나 "대화" 탭에 끼어들지 않는다.
 *
 * 무시가 아니라 화면 배치다. 세션은 그대로 동기화되고, 묶음을 펼치면 평소처럼
 * 열 수 있다. 목록은 사용자 설정(`auth.db`)에 살기 때문에 기기 사이에서 따라온다.
 */

/** 사용자 설정에 저장하는 모양. 펼침 여부도 같이 둔다 — 기본은 접힘이다. */
export type QuietFoldersState = {
  /** 정규화된 절대 경로. 이 폴더 자신과 그 아래 전부가 대상이다. */
  paths: string[];
  /** 사이드바 맨 아래 묶음을 펼쳐 두었는가. */
  expanded: boolean;
};

const PREFERENCE_KEY = 'quietFolders';

const EMPTY_STATE: QuietFoldersState = { paths: [], expanded: false };

/** 정규화 결과 캐시. `useSyncExternalStore` 가 같은 값에 같은 참조를 받아야 한다. */
let cachedRaw: unknown;
let cachedState: QuietFoldersState = EMPTY_STATE;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * 비교할 수 있는 모양으로 경로를 맞춘다. 맞출 수 없으면 빈 문자열.
 *
 * 절대 경로만 받는다. `~` 는 브라우저가 홈 디렉터리를 모르니 풀 수 없고, 상대
 * 경로는 무엇에 대한 상대인지 정할 수 없다. 루트(`/`, `C:/`)도 거절한다 — 모든
 * 프로젝트가 한꺼번에 사라지는 설정은 실수일 가능성이 훨씬 높다.
 */
export function normalizeQuietFolderPath(input: string): string {
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

function normalize(raw: unknown): QuietFoldersState {
  if (!isRecord(raw)) {
    return EMPTY_STATE;
  }

  const paths: string[] = [];
  if (Array.isArray(raw.paths)) {
    for (const entry of raw.paths) {
      const normalized = typeof entry === 'string' ? normalizeQuietFolderPath(entry) : '';
      if (normalized && !paths.includes(normalized)) {
        paths.push(normalized);
      }
    }
  }

  return { paths, expanded: raw.expanded === true };
}

/** 지금 저장된 목록. 설정한 적이 없으면 빈 목록, 접힌 상태다. */
export function readQuietFolders(): QuietFoldersState {
  const raw = readUserPreference<unknown>(PREFERENCE_KEY, null);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    const next = normalize(raw);
    // 묶음을 펼치고 접기만 했을 때는 경로 배열을 그대로 둔다. 이 배열에 매달린
    // "대화" 탭 다시 불러오기가 펼칠 때마다 돌지 않게 하려는 것이다.
    const samePaths = next.paths.length === cachedState.paths.length
      && next.paths.every((path, index) => path === cachedState.paths[index]);
    cachedState = samePaths ? { ...next, paths: cachedState.paths } : next;
  }
  return cachedState;
}

function writeQuietFolders(next: QuietFoldersState): void {
  writeUserPreference(PREFERENCE_KEY, next);
}

/** 폴더 하나를 더한다. 실제로 더했으면 true — 형식이 틀렸거나 이미 있으면 false. */
export function addQuietFolder(input: string): boolean {
  const normalized = normalizeQuietFolderPath(input);
  const current = readQuietFolders();
  if (!normalized || current.paths.includes(normalized)) {
    return false;
  }
  writeQuietFolders({ ...current, paths: [...current.paths, normalized] });
  return true;
}

/** 폴더 하나를 뺀다. 그 아래 프로젝트는 원래 자리로 돌아간다. */
export function removeQuietFolder(path: string): void {
  const current = readQuietFolders();
  writeQuietFolders({ ...current, paths: current.paths.filter((entry) => entry !== path) });
}

/** 사이드바 맨 아래 묶음을 펼치거나 접는다. */
export function setQuietFoldersExpanded(expanded: boolean): void {
  const current = readQuietFolders();
  if (current.expanded !== expanded) {
    writeQuietFolders({ ...current, expanded });
  }
}

/**
 * 이 경로가 조용한 폴더 자신이거나 그 아래에 있는가.
 *
 * 접두어만 보면 `/a/llm-sim` 이 `/a/llm-sim-v2` 까지 잡으므로, 경계가 `/` 에서
 * 끊기는지까지 확인한다. 경로가 없으면(세션에 작업 폴더가 기록되지 않은 경우)
 * 조용한 대상으로 보지 않는다.
 */
export function isPathInQuietFolders(projectPath: string | null | undefined, quietPaths: readonly string[]): boolean {
  if (!projectPath || quietPaths.length === 0) {
    return false;
  }

  const normalized = normalizeQuietFolderPath(projectPath);
  if (!normalized) {
    return false;
  }
  return quietPaths.some((folder) => normalized === folder || normalized.startsWith(`${folder}/`));
}
