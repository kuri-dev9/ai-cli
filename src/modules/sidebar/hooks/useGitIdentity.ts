import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { resolveGithubUsername } from '@/shared/githubAccount';
import { subscribeToUserPreferences } from '@/shared/userSettings';

type GitConfigResponse = {
  gitName?: string;
  gitEmail?: string;
  error?: string;
};

export type GitIdentity = {
  /** 배지에 보여줄 GitHub 계정명. 없으면 빈 문자열. */
  name: string;
  /** 계정 프로필 주소. 계정명이 없으면 null. */
  profileUrl: string | null;
};

/**
 * 배지에 쓸 신원을 정한다.
 *
 * 설정 > Git 의 "GitHub 사용자명" 이 1순위다. 비어 있으면 커밋 이름이 마침
 * GitHub 계정 형식일 때만 그걸 쓴다(예전 동작 유지). 둘 다 아니면 배지를
 * 그리지 않는다 — 없는 주소로 보내는 것보다 낫다.
 */
export function toGitIdentity(gitName: string): GitIdentity {
  const account = resolveGithubUsername(gitName);
  if (!account) {
    return { name: '', profileUrl: null };
  }

  return { name: account, profileUrl: `https://github.com/${account}` };
}

/**
 * 사이드바 배지가 쓰는 git 신원 정보.
 *
 * 값의 출처는 설정 > Git 화면과 같은 `GET /api/user/git-config` 다. 온보딩에서
 * 처음 입력한 뒤 설정 화면에서 고칠 수 있고, 여기서는 읽기만 한다.
 *
 * 설정 화면에서 값을 바꾸면 `git-config:updated` 이벤트가 오므로 그때 다시 읽는다.
 */
export function useGitIdentity(): GitIdentity {
  const [identity, setIdentity] = useState<GitIdentity>({ name: '', profileUrl: null });

  const load = useCallback(async () => {
    try {
      const response = await api.user.gitConfig();
      if (!response.ok) {
        return;
      }
      const data = await response.json() as GitConfigResponse;
      setIdentity(toGitIdentity(data.gitName ?? ''));
    } catch {
      // 사이드바 장식일 뿐이라 실패해도 조용히 비워둔다.
    }
  }, []);

  useEffect(() => {
    void load();

    // 커밋 정보는 서버에 저장되므로 이벤트로, GitHub 사용자명은 preference 라
    // 저장소 구독으로 각각 알림을 받는다. 어느 쪽을 고쳐도 배지가 따라간다.
    const onUpdated = () => void load();
    window.addEventListener('git-config:updated', onUpdated);
    const unsubscribe = subscribeToUserPreferences(() => void load());

    return () => {
      window.removeEventListener('git-config:updated', onUpdated);
      unsubscribe();
    };
  }, [load]);

  return identity;
}
