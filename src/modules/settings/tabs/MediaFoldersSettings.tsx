import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
import { addMediaFolder, normalizeMediaFolderPath, removeMediaFolder } from '@/shared/mediaFolders';
import { Button, Input } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsSection from '@/modules/settings/SettingsSection';

/**
 * Rendered by AppearanceSettingsTab to edit the media folder list.
 *
 * 여기 적은 폴더의 음원·영상이 오른쪽 미디어 패널에 모인다. 프로젝트 등록이
 * 아니라 보기 방식이라 사이드바에도, 파일 탭에도 나타나지 않는다. 저장은
 * 사용자 설정으로 바로 가므로 별도의 저장 버튼이 없다.
 */
export default function MediaFoldersSettings() {
  const { t } = useTranslation('settings');
  const paths = useMediaFolders();
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
      setError(t('appearanceSettings.mediaFolders.invalid'));
      return;
    }
    if (!addMediaFolder(normalized)) {
      setError(t('appearanceSettings.mediaFolders.duplicate'));
      return;
    }
    setDraft('');
    setError(null);
  };

  return (
    <SettingsSection
      title={t('appearanceSettings.mediaFolders.title')}
      description={t('appearanceSettings.mediaFolders.description')}
    >
      <SettingsCard divided>
        {paths.map((folder) => (
          <div key={folder} className="flex items-center gap-3 px-4 py-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={folder}>
              {folder}
            </code>
            <button
              type="button"
              onClick={() => removeMediaFolder(folder)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
              title={t('appearanceSettings.mediaFolders.remove')}
              aria-label={t('appearanceSettings.mediaFolders.remove')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}

        <div className="px-4 py-3">
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              placeholder={t('appearanceSettings.mediaFolders.placeholder')}
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
              {t('appearanceSettings.mediaFolders.add')}
            </Button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
