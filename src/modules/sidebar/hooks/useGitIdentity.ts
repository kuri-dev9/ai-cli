import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

type GitConfigResponse = {
  gitName?: string;
  gitEmail?: string;
  error?: string;
};

/**
 * GitHub 사용자명 규칙: 영숫자와 하이픈만, 하이픈으로 시작·끝날 수 없고
 * 연속된 하이픈도 안 되며 최대 39자.
 *
 * 설정의 "Git 이름" 은 커밋에 찍히는 표시 이름이라 "홍길동" 처럼 아무 문자열이나
 * 들어갈 수 있다. 그래서 규칙에 맞을 때만 프로필 링크를 건다. 안 맞으면 이름만
 * 보여주고 링크는 걸지 않는다 — 없는 주소로 보내는 것보다 낫다.
 */
const GITHUB_USERNAME = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9]){0,38}$/;

export type GitIdentity = {
  /** 설정 > Git 에 저장된 이름. 없으면 빈 문자열. */
  name: string;
  /** 이름이 GitHub 사용자명 형식일 때의 프로필 주소. 아니면 null. */
  profileUrl: string | null;
};

export function toGitIdentity(gitName: string): GitIdentity {
  const name = gitName.trim();
  if (!name) {
    return { name: '', profileUrl: null };
  }

  return {
    name,
    profileUrl: GITHUB_USERNAME.test(name) ? `https://github.com/${name}` : null,
  };
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

    const onUpdated = () => void load();
    window.addEventListener('git-config:updated', onUpdated);
    return () => window.removeEventListener('git-config:updated', onUpdated);
  }, [load]);

  return identity;
}
