import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Music, RefreshCw, X } from 'lucide-react';

import MediaPlayer from '@/modules/media-library/MediaPlayer';
import { useMediaFolderContents } from '@/modules/media-library/hooks/useMediaFolderContents';
import type { MediaFileEntry } from '@/modules/media-library/hooks/useMediaFolderContents';
import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
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
  const { t } = useTranslation();
  const folders = useMediaFolders(projectId);
  const { contents, reload } = useMediaFolderContents(folders);
  // 펼쳐 둔 파일들. 여러 곡을 나란히 열어 두고 비교할 수 있다.
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);

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
      <div className="flex shrink-0 items-center justify-end gap-0.5 border-b border-border px-2 py-1">
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

              {!collapsed && (
                <>
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
                  <ul className="pb-2">{folder.files.map(renderFile)}</ul>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
