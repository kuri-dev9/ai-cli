import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useQuietFolders } from '@/shared/hooks/useQuietFolders';
import { addQuietFolder, normalizeQuietFolderPath, removeQuietFolder } from '@/shared/quietFolders';
import { Button, Input } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';

/**
 * Rendered by AppearanceSettingsTab to edit the quiet folder list.
 *
 * 여기 적은 폴더 아래 프로젝트는 사이드바 맨 아래 "조용한 폴더" 묶음으로 모인다.
 * 저장은 사용자 설정으로 바로 가므로 별도의 저장 버튼이 없다.
 */
export default function QuietFoldersSettings() {
  const { t } = useTranslation('settings');
  const { paths } = useQuietFolders();
  // 아직 더하지 않은 입력값. 더하면 비운다.
  const [draft, setDraft] = useState('');
  // 방금 더하려던 값이 왜 거절됐는지. 입력을 고치면 지운다.
  const [error, setError] = useState<string | null>(null);

  const commitDraft = () => {
    if (!draft.trim()) {
      return;
    }
    const normalized = normalizeQuietFolderPath(draft);
    if (!normalized) {
      setError(t('appearanceSettings.quietFolders.invalid'));
      return;
    }
    if (!addQuietFolder(normalized)) {
      setError(t('appearanceSettings.quietFolders.duplicate'));
      return;
    }
    setDraft('');
    setError(null);
  };

  return (
    <SettingsSection
      title={t('appearanceSettings.quietFolders.title')}
      description={t('appearanceSettings.quietFolders.description')}
    >
      <SettingsCard divided>
        {paths.map((folder) => (
          <div key={folder} className="flex items-center gap-3 px-4 py-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={folder}>
              {folder}
            </code>
            <button
              type="button"
              onClick={() => removeQuietFolder(folder)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
              title={t('appearanceSettings.quietFolders.remove')}
              aria-label={t('appearanceSettings.quietFolders.remove')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}

        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              placeholder={t('appearanceSettings.quietFolders.placeholder')}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitDraft();
                }
              }}
              className="font-mono text-sm"
            />
            <Button type="button" variant="outline" size="sm" onClick={commitDraft} disabled={!draft.trim()}>
              <Plus />
              {t('appearanceSettings.quietFolders.add')}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
