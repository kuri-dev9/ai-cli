import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCog, Loader2, Trash2 } from 'lucide-react';

import type { MediaFileEntry } from '@/modules/media-library/hooks/useMediaFolderContents';
import { WorkspacePathField } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';

type MediaFileEditModalProps = {
  file: MediaFileEntry;
  /** 설정에 연결된 폴더들. 파일을 옮겨 둘 수 있는 자리다. */
  folders: readonly string[];
  /**
   * 파일이 바뀐 뒤. 더는 그 경로에 없는 파일을 넘긴다 — 변환처럼 원본이 그대로
   * 남는 작업은 null 이다. 듣고 있던 곡을 괜히 끊지 않기 위한 구분이다.
   */
  onChanged: (replacedPath: string | null) => void;
  onClose: () => void;
};

const selectClassName = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
  + ' text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

/** 경로에서 폴더만. 이 파일이 지금 어느 폴더에 있는지 고를 때 쓴다. */
const folderOf = (filePath: string) => filePath.slice(0, filePath.lastIndexOf('/'));

/** 확장자를 뺀 이름. 형식을 바꾸면 확장자만 갈아 끼운다. */
const stemOf = (fileName: string) => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};

/**
 * 연결된 폴더를 가리킬 짧은 이름.
 *
 * 마지막 한 조각으로는 모자란다 — 연결한 폴더들은 흔히 같은 이름으로 끝나서
 * (`…/tracks`), 둘을 가르는 쪽은 그 앞이다.
 */
const shortFolderLabel = (folderPath: string) => folderPath.split('/').slice(-2).join('/');

/** `.`으로 시작하는 폴더를 지나는 경로. Finder 에서는 보이지 않는 자리다. */
const isHiddenPath = (folderPath: string) =>
  folderPath.split('/').some((segment) => segment.startsWith('.'));

/**
 * Rendered by MediaLibraryPanel for the file whose pencil was pressed.
 *
 * 이름·폴더를 고치고, 다른 형식으로 바꾸고, 지우는 자리를 한 화면에 모은다.
 * 목록 행에 버튼을 늘어놓는 대신 여기로 들어온 이유는 되돌릴 수 없는 작업들이라
 * 한 번 더 들여다볼 자리가 필요해서다. 변환은 그중에서도 결과를 어디에 둘지
 * 먼저 정해야 해서 두 번째 화면으로 넘어간다.
 */
export default function MediaFileEditModal({
  file,
  folders,
  onChanged,
  onClose,
}: MediaFileEditModalProps) {
  const { t } = useTranslation();
  const currentFolder = folderOf(file.path);
  const [name, setName] = useState(file.name);
  const [folder, setFolder] = useState(currentFolder);
  // 'convert' 면 변환 결과를 어디에 쓸지 정하는 화면이다.
  const [step, setStep] = useState<'edit' | 'convert'>('edit');
  // 변환할 형식과 결과를 쓸 자리. 쓸 수 있는 형식은 서버가 알려준다.
  const [format, setFormat] = useState('');
  const [formats, setFormats] = useState<string[] | null>(null);
  const [convertFolder, setConvertFolder] = useState('');
  const [convertName, setConvertName] = useState('');
  // 지금 돌고 있는 작업. 하나가 끝나기 전에 다음을 시작하지 않는다.
  const [busy, setBusy] = useState<'save' | 'convert' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 변환은 서버에 ffmpeg 가 있을 때만 된다. 없으면 버튼을 내보내지 않는다.
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await api.mediaCapabilities({ signal: controller.signal });
        const data = response.ok
          ? await response.json() as { transcode?: boolean; formats?: string[] }
          : null;
        const available = data?.transcode ? data.formats ?? [] : [];
        setFormats(available);
        // 영상이 아니라면 mp4 가 첫 번째 쓸모 — 어디서나 열리는 형식이다.
        setFormat(available.find((entry) => entry === 'mp4') ?? available[0] ?? '');
      } catch {
        setFormats([]);
      }
    })();

    return () => controller.abort();
  }, []);

  const run = async (
    kind: 'save' | 'convert' | 'delete',
    action: () => Promise<Response>,
    after: (payload: { path?: string }) => void,
  ) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const response = await action();
      const payload = await response.json().catch(() => null) as
        { error?: string; path?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? t('mediaLibrary.actionFailed'));
        return;
      }
      // 변환만 원본을 그대로 둔다. 나머지는 이 경로가 비게 된다.
      onChanged(kind === 'convert' ? null : file.path);
      after(payload ?? {});
    } catch {
      setError(t('mediaLibrary.actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const renamed = name.trim() !== file.name;
  const moved = folder.trim() !== currentFolder;

  const save = () => void run(
    'save',
    () => api.moveMediaFile(file.path, {
      targetFolder: moved ? folder.trim() : null,
      name: renamed ? name.trim() : null,
    }),
    onClose,
  );

  const remove = () => {
    // 되돌릴 수 없는 작업이라 한 번 묻는다. 휴지통이 아니라 바로 지운다.
    if (!window.confirm(t('mediaLibrary.confirmDelete', { name: file.name }))) {
      return;
    }
    void run('delete', () => api.deleteMediaFile(file.path), onClose);
  };

  const openConvertStep = () => {
    // 만들어 낸 파일이 `.soriforge` 같은 숨은 폴더에 떨어지면 Finder 로는
    // 찾아갈 수가 없다. 원본 자리가 그런 곳이면 연결된 폴더 중 드러나 있는
    // 쪽을 먼저 권한다 — 어차피 들고 나가려고 바꾸는 파일이다.
    const startingFolder = isHiddenPath(currentFolder)
      ? folders.find((entry) => !isHiddenPath(entry)) ?? currentFolder
      : currentFolder;

    setConvertFolder(startingFolder);
    setConvertName(`${stemOf(name.trim() || file.name)}.${format}`);
    setError(null);
    setNotice(null);
    setStep('convert');
  };

  const changeFormat = (nextFormat: string) => {
    setFormat(nextFormat);
    // 확장자가 형식을 정하므로 이름을 따라 바꾼다. 서버도 같은 규칙으로 한 번
    // 더 맞춰 두지만, 적어 둔 이름과 실제 결과가 달라 보이면 안 된다.
    setConvertName((current) => `${stemOf(current)}.${nextFormat}`);
  };

  const convert = () => void run(
    'convert',
    () => api.transcodeMediaFile(file.path, format, {
      targetFolder: convertFolder.trim(),
      name: convertName.trim(),
    }),
    (payload) => {
      // 원본은 그대로 남으므로 창을 닫지 않고 첫 화면으로 돌아간다. 어디에
      // 만들었는지가 이 작업의 요점이라 경로를 통째로 보여준다.
      setStep('edit');
      setNotice(t('mediaLibrary.converted', { path: payload.path ?? convertName }));
    },
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-file-edit-title"
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <FileCog className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="media-file-edit-title" className="text-base font-semibold text-foreground">
              {t(step === 'convert' ? 'mediaLibrary.convertTitle' : 'mediaLibrary.editTitle')}
            </h3>
            <p className="truncate text-xs text-muted-foreground" title={file.path}>
              {file.path}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-border px-5 py-4">
          {step === 'edit' ? (
            <>
              <div>
                <label htmlFor="media-file-name" className="mb-1.5 block text-sm font-medium text-foreground">
                  {t('mediaLibrary.fileName')}
                </label>
                <Input
                  id="media-file-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy !== null}
                  autoFocus
                />
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  {t('mediaLibrary.folder')}
                </label>
                {/* 연결해 둔 폴더 바깥으로도 옮길 수 있어야 한다. 프로젝트를
                    만들 때 쓰는 경로 입력을 그대로 쓴다 — 자동완성과 폴더
                    고르기가 함께 온다. */}
                <WorkspacePathField
                  value={folder}
                  disabled={busy !== null}
                  onChange={setFolder}
                />
                {folders.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {folders.filter((entry) => entry !== folder).map((entry) => (
                      <button
                        key={entry}
                        type="button"
                        onClick={() => setFolder(entry)}
                        disabled={busy !== null}
                        className="max-w-full truncate rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={entry}
                      >
                        {shortFolderLabel(entry)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-4">
                {formats !== null && formats.length === 0 ? (
                  <>
                    <p className="mb-1.5 text-sm font-medium text-foreground">
                      {t('mediaLibrary.convertSection')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('mediaLibrary.convertUnavailable')}
                    </p>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    onClick={openConvertStep}
                    disabled={busy !== null || formats === null || !format}
                    className="w-full"
                  >
                    {t('mediaLibrary.convertSection')}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="media-convert-format" className="mb-1.5 block text-sm font-medium text-foreground">
                  {t('mediaLibrary.format')}
                </label>
                <select
                  id="media-convert-format"
                  value={format}
                  onChange={(event) => changeFormat(event.target.value)}
                  disabled={busy !== null}
                  className={selectClassName}
                >
                  {(formats ?? []).map((entry) => (
                    <option key={entry} value={entry}>{entry}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-foreground">
                  {t('mediaLibrary.saveLocation')}
                </label>
                <WorkspacePathField
                  value={convertFolder}
                  disabled={busy !== null}
                  onChange={setConvertFolder}
                />
              </div>

              <div>
                <label htmlFor="media-convert-name" className="mb-1.5 block text-sm font-medium text-foreground">
                  {t('mediaLibrary.fileName')}
                </label>
                <Input
                  id="media-convert-name"
                  value={convertName}
                  onChange={(event) => setConvertName(event.target.value)}
                  disabled={busy !== null}
                />
              </div>

              <p className="text-xs text-muted-foreground">{t('mediaLibrary.convertHint')}</p>
            </>
          )}

          {error && <p className="break-all text-xs text-red-600 dark:text-red-400">{error}</p>}
          {notice && (
            <p className="break-all text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 p-4">
          {step === 'edit' ? (
            <Button
              variant="ghost"
              onClick={remove}
              disabled={busy !== null}
              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-900/20"
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {t('mediaLibrary.delete')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setStep('edit')} disabled={busy !== null}>
              {t('mediaLibrary.back')}
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
              {t('buttons.cancel')}
            </Button>
            {step === 'edit' ? (
              <Button
                onClick={save}
                disabled={busy !== null || (!renamed && !moved) || !name.trim() || !folder.trim()}
              >
                {busy === 'save' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {t('buttons.save')}
              </Button>
            ) : (
              <Button
                onClick={convert}
                disabled={busy !== null || !convertFolder.trim() || !convertName.trim()}
              >
                {busy === 'convert' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {busy === 'convert' ? t('mediaLibrary.converting') : t('mediaLibrary.convert')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
