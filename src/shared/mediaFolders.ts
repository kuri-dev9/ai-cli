import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 플레이어 패널이 훑을 폴더 목록.
 *
 * 만들어진 음원·영상은 프로젝트 안이 아니라 도구가 쓰는 제 폴더에 쌓이는 경우가
 * 많다. 그런 폴더를 여기에 적어 두면 어느 프로젝트를 열고 있든 오른쪽 패널에서
 * 목록을 보고 바로 들을 수 있다.
 *
 * 프로젝트 등록이 아니라 보기 방식이다. 사이드바에도, 파일 탭에도 나타나지
 * 않는다. 목록은 사용자 설정(`auth.db`)에 살기 때문에 기기 사이에서 따라온다.
 *
 * 경로 규칙은 [[quietFolders]] 와 같은 이유로 같다 — 절대 경로만 받는다.
 */

const PREFERENCE_KEY = 'mediaFolders';

const EMPTY_PATHS: string[] = [];

/** 정규화 결과 캐시. `useSyncExternalStore` 가 같은 값에 같은 참조를 받아야 한다. */
let cachedRaw: unknown;
let cachedPaths: string[] = EMPTY_PATHS;

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

function normalize(raw: unknown): string[] {
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

/** 지금 저장된 폴더 목록. 설정한 적이 없으면 빈 목록이다. */
export function readMediaFolders(): string[] {
  const raw = readUserPreference<unknown>(PREFERENCE_KEY, null);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    const next = normalize(raw);
    // 내용이 같으면 같은 배열을 유지한다 — 이 배열에 매달린 목록 다시 읽기가
    // 설정을 저장할 때마다 돌지 않게 하려는 것이다.
    const same = next.length === cachedPaths.length
      && next.every((path, index) => path === cachedPaths[index]);
    cachedPaths = same ? cachedPaths : next;
  }
  return cachedPaths;
}

/** 폴더 하나를 더한다. 실제로 더했으면 true — 형식이 틀렸거나 이미 있으면 false. */
export function addMediaFolder(input: string): boolean {
  const normalized = normalizeMediaFolderPath(input);
  const current = readMediaFolders();
  if (!normalized || current.includes(normalized)) {
    return false;
  }
  writeUserPreference(PREFERENCE_KEY, [...current, normalized]);
  return true;
}

/** 폴더 하나를 뺀다. 그 폴더의 파일은 패널에서 사라질 뿐 디스크는 그대로다. */
export function removeMediaFolder(folderPath: string): void {
  const current = readMediaFolders();
  writeUserPreference(PREFERENCE_KEY, current.filter((entry) => entry !== folderPath));
}

/** 경로에서 사람이 읽을 폴더 이름만 꺼낸다. 목록 머리글에 쓴다. */
export function mediaFolderLabel(folderPath: string): string {
  return folderPath.split('/').filter(Boolean).pop() ?? folderPath;
}
