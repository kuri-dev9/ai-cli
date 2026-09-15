import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * 사이드바 배지가 가리킬 GitHub 계정.
 *
 * 처음에는 설정 > Git 의 "Git 이름" 을 그대로 GitHub 계정으로 썼는데, 그건
 * 틀린 가정이었다. `user.name` 은 커밋에 찍히는 작성자 이름이라 실명이나
 * 회사 표기를 쓰는 경우가 많고, GitHub 계정과 같을 이유가 없다. 배지 하나
 * 때문에 커밋 작성자 이름까지 계정명으로 바꿔야 하는 상황이 됐다.
 *
 * 그래서 계정명을 따로 저장한다. 커밋 정보(`git config --global`)와 달리
 * 이건 이 앱의 표시용이므로 사용자 preference 에 둔다.
 */

/**
 * GitHub 사용자명 규칙: 영숫자와 하이픈만, 하이픈으로 시작·끝날 수 없고
 * 연속된 하이픈도 안 되며 최대 39자.
 */
const GITHUB_USERNAME = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/;

export function isValidGithubUsername(value: string): boolean {
  return GITHUB_USERNAME.test(value.trim());
}

export function readGithubUsername(): string {
  const stored = readUserPreference<string | null>('githubUsername', null);
  return typeof stored === 'string' ? stored.trim() : '';
}

export function writeGithubUsername(value: string): void {
  writeUserPreference('githubUsername', value.trim());
}

/** 배지에 쓸 계정명. 비워 두면 커밋 이름으로 폴백한다(예전 동작). */
export function resolveGithubUsername(gitName: string): string {
  const explicit = readGithubUsername();
  if (explicit) {
    return explicit;
  }
  // 계정명을 따로 넣지 않았어도, 커밋 이름이 마침 GitHub 계정 형식이면 그걸 쓴다.
  // 이 기능이 생기기 전부터 쓰던 사람의 배지가 갑자기 사라지지 않게 하기 위해서다.
  const fallback = gitName.trim();
  return isValidGithubUsername(fallback) ? fallback : '';
}
