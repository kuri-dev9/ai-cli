import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { normalizeMediaFolderPath } from '@/shared/mediaFolders';
import { Button, Input } from '@/shared/ui';

type MediaFoldersFieldProps = {
  folders: string[];
  disabled: boolean;
  onChange: (folders: string[]) => void;
};

/**
 * Rendered by ProjectSettingsModal to edit this project's media folders.
 *
 * 여기 적은 폴더의 음원·영상이 오른쪽 미디어 패널에 모인다. 이 화면의 다른
 * 항목과 같은 규칙을 따른다 — 더하거나 빼기만 해서는 저장되지 않고, 저장을
 * 눌러야 반영된다.
 */
export default function MediaFoldersField({ folders, disabled, onChange }: MediaFoldersFieldProps) {
  const { t } = useTranslation();
  // 아직 더하지 않은 입력값. 더하면 비운다.
  const [draft, setDraft] = useState('');
  // 방금 더하려던 값이 왜 거절됐는지. 입력을 고치면 지운다.
  const [error, setError] = useState<string | null>(null);

  const commitDraft = () => {
    if (!draft.trim()) {
      return;
    }

    const normalized = normalizeMediaFolderPath(draft);
    if (!normalized) {
      setError(t('mediaLibrary.folders.invalid'));
      return;
    }
    if (folders.includes(normalized)) {
      setError(t('mediaLibrary.folders.duplicate'));
      return;
    }

    onChange([...folders, normalized]);
    setDraft('');
    setError(null);
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('mediaLibrary.folders.label')}
      </label>

      {folders.length > 0 && (
        <ul className="mb-2 space-y-1">
          {folders.map((folder) => (
            <li
              key={folder}
              className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-700"
            >
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={folder}>
                {folder}
              </code>
              <button
                type="button"
                onClick={() => onChange(folders.filter((entry) => entry !== folder))}
                disabled={disabled}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                title={t('mediaLibrary.folders.remove')}
                aria-label={t('mediaLibrary.folders.remove')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={draft}
          disabled={disabled}
          placeholder={t('mediaLibrary.folders.placeholder')}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitDraft();
            }
          }}
          className="font-mono text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={commitDraft}
          disabled={disabled || !draft.trim()}
        >
          <Plus />
          {t('mediaLibrary.folders.add')}
        </Button>
      </div>

      {error
        ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
        : <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('mediaLibrary.folders.help')}</p>}
    </div>
  );
}
