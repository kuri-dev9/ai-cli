import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type MediaFileMetadata = {
  size: number | null;
  modifiedAt: string | null;
};

/**
 * 파일 크기와 수정 시각을 응답 헤더에서 읽어 온다.
 *
 * 목록에서 연 파일은 이미 둘 다 알고 있으므로 요청하지 않는다. 채팅 본문처럼
 * 경로만 아는 자리에서만 HEAD 를 한 번 보낸다 — 서버가 헤더만 돌려주므로
 * 파일을 읽지 않는다.
 */
export function useMediaFileMetadata(
  filePath: string,
  known: MediaFileMetadata,
): MediaFileMetadata {
  const [fetched, setFetched] = useState<MediaFileMetadata>({ size: null, modifiedAt: null });
  const needsFetch = known.size === null || known.modifiedAt === null;

  useEffect(() => {
    if (!needsFetch) {
      return undefined;
    }

    const controller = new AbortController();
    api.mediaMetadata(filePath, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          return;
        }
        const length = response.headers.get('content-length');
        setFetched({
          size: length === null ? null : Number.parseInt(length, 10),
          modifiedAt: response.headers.get('last-modified'),
        });
      })
      .catch(() => {
        // 메타데이터는 덤이다. 못 읽으면 재생만 하고 표시를 줄인다.
      });

    return () => controller.abort();
  }, [filePath, needsFetch]);

  return {
    size: known.size ?? fetched.size,
    modifiedAt: known.modifiedAt ?? fetched.modifiedAt,
  };
}
