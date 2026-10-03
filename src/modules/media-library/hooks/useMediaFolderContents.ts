import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';

export type MediaFileEntry = {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: string | null;
  contentType: string;
};

export type MediaFolderContents = {
  folderPath: string;
  files: MediaFileEntry[];
  /** 폴더가 사라졌거나 읽을 수 없다. 나머지 폴더는 그대로 보여준다. */
  error: boolean;
};

type LoadedContents = {
  /** 어떤 폴더 목록에 대한 결과인지. 설정이 바뀌면 이 값이 달라진다. */
  key: string;
  items: MediaFolderContents[];
};

/**
 * 등록된 폴더들의 재생 가능한 파일 목록.
 *
 * 설정에 오래된 경로가 하나 남았다고 패널 전체가 비면 곤란하므로, 폴더 하나가
 * 실패해도 나머지는 그대로 싣는다. 아직 읽는 중이면 `null` 이다 — 로딩 여부를
 * 따로 저장하지 않고 결과가 지금 폴더 목록의 것인지로 판별한다.
 */
export function useMediaFolderContents(folderPaths: readonly string[]) {
  const [loaded, setLoaded] = useState<LoadedContents | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const key = useMemo(() => folderPaths.join('\n'), [folderPaths]);
  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      const items = await Promise.all(folderPaths.map(async (folderPath): Promise<MediaFolderContents> => {
        try {
          const response = await api.listMediaFolder(folderPath, { signal: controller.signal });
          if (!response.ok) {
            return { folderPath, files: [], error: true };
          }
          const data = await response.json() as { files?: MediaFileEntry[] };
          return { folderPath, files: Array.isArray(data.files) ? data.files : [], error: false };
        } catch {
          return { folderPath, files: [], error: true };
        }
      }));

      if (!controller.signal.aborted) {
        setLoaded({ key, items });
      }
    };

    void load();
    return () => controller.abort();
    // `folderPaths` 는 내용이 같으면 같은 배열이므로 `key` 와 함께 돌아도 안전하다.
  }, [folderPaths, key, reloadToken]);

  // 결과가 지금 폴더 목록의 것일 때만 쓴다. 아니면 아직 읽는 중이다.
  const contents = loaded && loaded.key === key ? loaded.items : null;

  return { contents, reload };
}
