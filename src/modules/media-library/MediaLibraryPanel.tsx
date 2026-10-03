import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Music, RefreshCw, X } from 'lucide-react';

import MediaPlayer from '@/modules/media-library/MediaPlayer';
import { useMediaFolderContents } from '@/modules/media-library/hooks/useMediaFolderContents';
import type { MediaFileEntry } from '@/modules/media-library/hooks/useMediaFolderContents';
import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
import { formatMediaDate } from '@/modules/media-library/utils/mediaMeta';
import { mediaFolderLabel } from '@/shared/mediaFolders';

type MediaLibraryPanelProps = {
  /** 폴더 목록을 어느 프로젝트에서 읽을지. */
  projectId: string | null | undefined;
  /** 바깥에서 열어 준 파일. 목록보다 먼저, 맨 위에 펼쳐 둔다. */
  openedFilePath: string | null;
  onClose: () => void;
};

const kindOf = (contentType: string): 'audio' | 'video' =>
  (contentType.startsWith('video/') ? 'video' : 'audio');

type SortKey = 'date' | 'name';

/**
 * 목록 정렬. 기본은 만든 날짜 내림차순 — 패널은 보통 방금 만든 것을 들으려고
 * 연다. 같은 날짜가 여럿이면 이름으로 갈라 순서가 흔들리지 않게 한다.
 */
function sortFiles(files: MediaFileEntry[], key: SortKey, ascending: boolean): MediaFileEntry[] {
  const direction = ascending ? 1 : -1;
  return [...files].sort((left, right) => {
    if (key === 'name') {
      return left.relativePath.localeCompare(right.relativePath) * direction;
    }
    const byDate = (left.modifiedAt ?? '').localeCompare(right.modifiedAt ?? '');
    return (byDate || left.relativePath.localeCompare(right.relativePath)) * direction;
  });
}

/**
 * Rendered by the project-workspace module beside the workspace content.
 *
 * 설정에 적어 둔 폴더의 음원·영상을 모아 보여주고, 누르면 그 자리에서 재생한다.
 * 대화를 보면서 듣기 위한 자리라 패널은 한 번 열리면 계속 떠 있고, 재생 중에
 * 에디터로 전환해도 소리는 끊기지 않는다.
 */
export default function MediaLibraryPanel({
  projectId,
  openedFilePath,
  onClose,
}: MediaLibraryPanelProps) {
  const { t, i18n } = useTranslation();
  const folders = useMediaFolders(projectId);
  const { contents, reload } = useMediaFolderContents(folders);
  // 펼쳐 둔 파일들. 여러 곡을 나란히 열어 두고 비교할 수 있다.
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [ascending, setAscending] = useState(false);

  // 같은 버튼을 다시 누르면 방향만 뒤집는다.
  const applySort = (key: SortKey) => {
    if (key === sortKey) {
      setAscending((previous) => !previous);
      return;
    }
    setSortKey(key);
    setAscending(key === 'name');
  };

  const SortArrow = ascending ? ArrowUp : ArrowDown;

  const togglePath = (filePath: string) => {
    setOpenPaths((open) => (
      open.includes(filePath) ? open.filter((entry) => entry !== filePath) : [...open, filePath]
    ));
  };

  const renderFile = (file: MediaFileEntry) => {
    const isOpen = openPaths.includes(file.path);

    return (
      <li key={file.path} className="px-2 py-1">
        <button
          type="button"
          onClick={() => togglePath(file.path)}
          aria-expanded={isOpen}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          title={file.path}
        >
          <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{file.relativePath}</span>
          {formatMediaDate(file.modifiedAt, i18n.language) && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatMediaDate(file.modifiedAt, i18n.language)}
            </span>
          )}
        </button>

        {isOpen && (
          <div className="px-2 pb-2 pt-1">
            <MediaPlayer
              filePath={file.path}
              label={file.name}
              kind={kindOf(file.contentType)}
              size={file.size}
              modifiedAt={file.modifiedAt}
              autoPlay
            />
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-2 py-1">
        {(['date', 'name'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => applySort(key)}
            aria-pressed={sortKey === key}
            className={`flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs hover:bg-muted ${sortKey === key ? 'text-foreground' : 'text-muted-foreground'
              }`}
            title={t(key === 'date' ? 'mediaLibrary.sortByDate' : 'mediaLibrary.sortByName')}
          >
            {t(key === 'date' ? 'mediaLibrary.sortByDate' : 'mediaLibrary.sortByName')}
            {sortKey === key && <SortArrow className="h-3 w-3" />}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={reload}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('mediaLibrary.refresh')}
          aria-label={t('mediaLibrary.refresh')}
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={t('mediaLibrary.close')}
          aria-label={t('mediaLibrary.close')}
        >
          <X className="h-4 w-4" />
        </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {openedFilePath && (
          <div className="border-b border-border p-3">
            <MediaPlayer
              filePath={openedFilePath}
              label={openedFilePath.split('/').pop() ?? openedFilePath}
              kind={/\.(mp4|webm|mov|m4v|ogv)$/i.test(openedFilePath) ? 'video' : 'audio'}
              autoPlay
            />
          </div>
        )}

        {folders.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">{t('mediaLibrary.empty')}</p>
        )}

        {contents === null && folders.length > 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">{t('mediaLibrary.loading')}</p>
        )}

        {(contents ?? []).map((folder) => {
          const collapsed = collapsedFolders.includes(folder.folderPath);
          const Chevron = collapsed ? ChevronRight : ChevronDown;

          return (
            <section key={folder.folderPath} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => setCollapsedFolders((list) => (
                  collapsed
                    ? list.filter((entry) => entry !== folder.folderPath)
                    : [...list, folder.folderPath]
                ))}
                aria-expanded={!collapsed}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-muted"
                title={folder.folderPath}
              >
                <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {mediaFolderLabel(folder.folderPath)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{folder.files.length}</span>
              </button>

              {/* 접을 때 숨기기만 하고 내리지 않는다. 목록을 들어내면 그 안에서
                  재생 중이던 플레이어까지 사라져 노래가 끊긴다. */}
              <div className={collapsed ? 'hidden' : undefined}>
                {folder.error && (
                  <p className="px-4 pb-3 text-xs text-muted-foreground">
                    {t('mediaLibrary.folderUnavailable')}
                  </p>
                )}
                {!folder.error && folder.files.length === 0 && (
                  <p className="px-4 pb-3 text-xs text-muted-foreground">
                    {t('mediaLibrary.folderEmpty')}
                  </p>
                )}
                <ul className="pb-2">
                  {sortFiles(folder.files, sortKey, ascending).map(renderFile)}
                </ul>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
