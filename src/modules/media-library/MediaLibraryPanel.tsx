import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Music, Pencil, RefreshCw, X } from 'lucide-react';

import MediaFileEditModal from '@/modules/media-library/MediaFileEditModal';
import MediaPlayer from '@/modules/media-library/MediaPlayer';
import { useMediaFolderContents } from '@/modules/media-library/hooks/useMediaFolderContents';
import type { MediaFileEntry } from '@/modules/media-library/hooks/useMediaFolderContents';
import { api } from '@/shared/api';
import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
import { formatMediaDate } from '@/modules/media-library/utils/mediaMeta';

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
 * 설정에 적어 둔 폴더의 음원·영상을 모아 위쪽 목록에 보여주고, 고른 한 곡을
 * 패널 맨 아래 고정된 플레이어에서 재생한다. 예전에는 행마다 플레이어를 펼쳐
 * 여러 곡이 겹쳐 울렸고, 곡이 끝나면 어느 플레이어가 무엇이었는지 알 수 없었다.
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
  // 지금 플레이어에 올라가 있는 한 곡. 한 번에 하나만 울린다.
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // 같은 곡을 다시 고르면 플레이어를 새로 올려 처음부터 재생한다.
  const [playToken, setPlayToken] = useState(0);
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
  // 방금 실패한 파일 작업의 메시지. 다음 작업을 시작하면 지운다.
  const [actionError, setActionError] = useState<string | null>(null);
  // 수정 창을 띄워 둔 파일. null 이면 닫혀 있다.
  const [editing, setEditing] = useState<MediaFileEntry | null>(null);
  // 지금 끌고 있는 파일과, 그 아래 들어온 폴더. 둘 다 끌기가 끝나면 비운다.
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  const runFileAction = async (action: () => Promise<Response>, filePath: string) => {
    setActionError(null);
    try {
      const response = await action();
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setActionError(body?.error ?? t('mediaLibrary.actionFailed'));
        return;
      }
      // 사라졌거나 옮겨 간 파일을 플레이어에 남겨 두지 않는다.
      setCurrentPath((current) => (current === filePath ? null : current));
      reload();
    } catch {
      setActionError(t('mediaLibrary.actionFailed'));
    }
  };

  // 수정 창이 파일을 바꿨다. 창은 자기 실패를 자기가 말하므로 여기서는
  // 목록을 다시 읽고, 가리키던 파일이 사라진 플레이어만 접는다.
  const handleFileChanged = (replacedPath: string | null) => {
    if (replacedPath) {
      setCurrentPath((current) => (current === replacedPath ? null : current));
    }
    reload();
  };

  // 끌어다 놓아 옮긴다. 같은 폴더로는 놓을 수 없으므로 받지 않는다.
  const canDropInto = (folderPath: string) => draggingPath !== null
    && draggingPath.slice(0, draggingPath.lastIndexOf('/')) !== folderPath;

  const dropInto = (folderPath: string) => {
    const sourcePath = draggingPath;
    setDraggingPath(null);
    setDropFolder(null);
    if (sourcePath) {
      void runFileAction(
        () => api.moveMediaFile(sourcePath, { targetFolder: folderPath }),
        sourcePath,
      );
    }
  };

  const playFile = (filePath: string) => {
    setCurrentPath(filePath);
    setPlayToken((token) => token + 1);
  };

  // 바깥(채팅 본문 등)에서 연 파일도 같은 플레이어가 받는다.
  useEffect(() => {
    if (openedFilePath) {
      setCurrentPath(openedFilePath);
      setPlayToken((token) => token + 1);
    }
  }, [openedFilePath]);

  // 플레이어가 크기·수정일을 다시 묻지 않도록 목록에서 아는 값을 찾아 넘긴다.
  const currentEntry = currentPath === null
    ? null
    : (contents ?? [])
      .flatMap((folder) => folder.files)
      .find((file) => file.path === currentPath) ?? null;

  const renderFile = (file: MediaFileEntry) => {
    const isCurrent = currentPath === file.path;

    return (
      <li
        key={file.path}
        className={`px-2 py-1 ${draggingPath === file.path ? 'opacity-50' : ''}`}
        // 다른 폴더 머리글 위에 놓으면 그리로 옮긴다. 목록 안에서 자리를
        // 옮기는 일이라 파일 하나를 통째로 끄는 편이 집기 쉽다.
        draggable
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', file.path);
          setDraggingPath(file.path);
        }}
        onDragEnd={() => {
          setDraggingPath(null);
          setDropFolder(null);
        }}
      >
        <div
          className={`group flex min-w-0 items-center rounded-md hover:bg-muted ${isCurrent ? 'bg-muted' : ''
            }`}
        >
          <button
            type="button"
            onClick={() => playFile(file.path)}
            aria-current={isCurrent ? 'true' : undefined}
            className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm ${isCurrent ? 'font-medium text-foreground' : ''
              }`}
            title={file.path}
          >
            <Music className={`h-3.5 w-3.5 shrink-0 ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="min-w-0 flex-1 truncate">{file.relativePath}</span>
            {formatMediaDate(file.modifiedAt, i18n.language) && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatMediaDate(file.modifiedAt, i18n.language)}
              </span>
            )}
          </button>

          {/* 평소에는 비켜 있다가 행에 손이 닿으면 나온다. 키보드로 짚어도
              보이도록 포커스에도 같이 걸어 둔다. */}
          <button
            type="button"
            onClick={() => setEditing(file)}
            className="mr-1 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-100"
            title={t('mediaLibrary.edit')}
            aria-label={t('mediaLibrary.edit')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
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

      {actionError && (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {actionError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {folders.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">{t('mediaLibrary.empty')}</p>
        )}

        {contents === null && folders.length > 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">{t('mediaLibrary.loading')}</p>
        )}

        {(contents ?? []).map((folder) => {
          const collapsed = collapsedFolders.includes(folder.folderPath);
          const Chevron = collapsed ? ChevronRight : ChevronDown;

          const isDropTarget = dropFolder === folder.folderPath;

          return (
            <section
              key={folder.folderPath}
              className={`border-b border-border last:border-b-0 ${isDropTarget ? 'bg-primary/10 ring-1 ring-inset ring-primary' : ''
                }`}
              onDragOver={(event) => {
                if (!canDropInto(folder.folderPath)) {
                  return;
                }
                // 막지 않으면 브라우저가 놓기를 거절한다.
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropFolder(folder.folderPath);
              }}
              onDragLeave={(event) => {
                // 안쪽 요소 사이를 지나는 동안에도 떠난 것으로 치지 않는다.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropFolder((current) => current === folder.folderPath ? null : current);
                }
              }}
              onDrop={(event) => {
                if (!canDropInto(folder.folderPath)) {
                  return;
                }
                event.preventDefault();
                dropInto(folder.folderPath);
              }}
            >
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
                {/* 끝이 아니라 앞을 자른다. 연결한 폴더들이 흔히 같은 이름으로
                    끝나므로(`…/tracks`), 구분되는 쪽은 앞이 아니라 뒤다. */}
                <span
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium"
                  style={{ direction: 'rtl' }}
                >
                  &lrm;{folder.folderPath}
                </span>
                {/* 끌고 있는 동안만 받을 수 있다고 말해 준다. 끌어다 놓기는
                    말해 주지 않으면 아무도 찾지 못하는 기능이다. */}
                {canDropInto(folder.folderPath) ? (
                  <span className="shrink-0 text-xs text-primary">{t('mediaLibrary.dropHere')}</span>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">{folder.files.length}</span>
                )}
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

      {/* 플레이어는 목록 밖, 패널 맨 아래에 붙여 둔다. 목록을 접거나 끝까지
          스크롤해도 지금 무엇이 울리는지가 제목과 함께 그대로 남는다. */}
      {currentPath && (
        <div className="shrink-0 border-t border-border bg-background p-3">
          <div className="flex min-w-0 items-center gap-2 pb-1">
            <p className="min-w-0 flex-1 truncate text-sm font-medium" title={currentPath}>
              {currentEntry?.relativePath ?? currentPath.split('/').pop()}
            </p>
            <button
              type="button"
              onClick={() => setCurrentPath(null)}
              className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('mediaLibrary.stopPlayback')}
              aria-label={t('mediaLibrary.stopPlayback')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* 고른 곡이 바뀌면 플레이어를 새로 올린다 — 같은 곡을 다시 골랐을
              때도 처음부터 들려야 하므로 토큰까지 열쇠에 넣는다. */}
          <MediaPlayer
            key={`${currentPath}#${playToken}`}
            filePath={currentPath}
            kind={currentEntry
              ? kindOf(currentEntry.contentType)
              : (/\.(mp4|webm|mov|m4v|ogv)$/i.test(currentPath) ? 'video' : 'audio')}
            size={currentEntry?.size ?? null}
            modifiedAt={currentEntry?.modifiedAt ?? null}
            autoPlay
          />
        </div>
      )}

      {editing && (
        <MediaFileEditModal
          file={editing}
          folders={folders}
          onChanged={handleFileChanged}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
