import { useCallback, useState } from 'react';
import { AlertTriangle, Loader2, Settings2, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import { ErrorBanner, WorkspacePathField } from '@/modules/project-creation-wizard';
import MediaFoldersField from '@/modules/project-settings/MediaFoldersField';
import { updateProjectPathRequest } from '@/modules/project-settings/utils/projectSettingsApi';
import { useProjectGroups } from '@/modules/sidebar';
import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
import { writeMediaFolders } from '@/shared/mediaFolders';
import type { Project } from '@/shared/types';

type ProjectSettingsModalProps = {
  project: Project;
  onClose: () => void;
  /** 저장이 끝난 뒤 사이드바 목록을 다시 읽게 한다. */
  onSaved: () => Promise<void> | void;
  /**
   * 프로젝트 제거 확인창을 연다. 사이드바 행에 있던 휴지통 버튼을 이 화면으로
   * 옮겼다 — 자주 누를 일이 없는 데다 새 세션 버튼 옆에서 잘못 눌리기 쉬웠다.
   */
  onRequestDelete: () => void;
};

/**
 * Renames a project and/or repoints it at another folder.
 *
 * 경로 변경은 DB 가 가리키는 위치만 바꾼다 — 폴더를 옮기지는 않으므로, 폴더를
 * 옮길 생각이라면 사용자가 먼저 옮긴 뒤 이 화면에서 새 위치를 지정한다.
 */
export default function ProjectSettingsModal({
  project,
  onClose,
  onSaved,
  onRequestDelete,
}: ProjectSettingsModalProps) {
  const { t } = useTranslation(['common', 'sidebar']);
  const originalPath = project.fullPath || project.path || '';
  const [displayName, setDisplayName] = useState(project.displayName || '');
  const [projectPath, setProjectPath] = useState(originalPath);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 그룹도 이 화면의 다른 항목과 같은 규칙을 따른다 — 고르기만 해서는 바뀌지
  // 않고, 저장을 눌러야 사이드바에 반영된다. 취소하면 원래 그룹에 그대로 남는다.
  const { groups, assignments, assignProject } = useProjectGroups();
  const savedGroupId = assignments[project.projectId] ?? '';
  const [groupId, setGroupId] = useState(savedGroupId);
  // 미디어 폴더도 같은 규칙이다 — 더하거나 빼기만 해서는 바뀌지 않고, 저장을
  // 눌러야 반영된다. 취소하면 원래 목록 그대로 남는다.
  const savedMediaFolders = useMediaFolders(project.projectId);
  const [mediaFolders, setMediaFolders] = useState<string[]>(savedMediaFolders);

  const trimmedPath = projectPath.trim();
  const trimmedDisplayName = displayName.trim();
  const pathChanged = trimmedPath !== originalPath;
  const nameChanged = trimmedDisplayName !== (project.displayName || '');
  const groupChanged = groupId !== savedGroupId;
  const mediaFoldersChanged = mediaFolders.length !== savedMediaFolders.length
    || mediaFolders.some((folder, index) => folder !== savedMediaFolders[index]);
  const canSave = !isSaving
    && trimmedPath.length > 0
    && (pathChanged || nameChanged || groupChanged || mediaFoldersChanged);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);

    try {
      // 경로를 먼저 옮긴다. 경로 변경이 실패하면 이름도 그대로 두어야
      // 사용자가 보는 상태와 저장된 상태가 어긋나지 않는다.
      if (pathChanged) {
        await updateProjectPathRequest(project.projectId, trimmedPath);
      }

      if (nameChanged) {
        const response = await api.renameProject(project.projectId, trimmedDisplayName);
        if (!response.ok) {
          throw new Error(t('projectWizard.projectSettings.failedToSave'));
        }
      }

      // 서버 작업이 모두 성공한 뒤에만 그룹을 옮긴다. 경로/이름이 실패해 이
      // 화면이 열린 채 남았을 때 그룹만 먼저 바뀌어 있으면 안 된다.
      if (groupChanged) {
        assignProject(project.projectId, groupId || null);
      }

      if (mediaFoldersChanged) {
        writeMediaFolders(project.projectId, mediaFolders);
      }

      await onSaved();
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('projectWizard.projectSettings.failedToSave'),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    assignProject,
    groupChanged,
    groupId,
    mediaFolders,
    mediaFoldersChanged,
    nameChanged,
    onClose,
    onSaved,
    pathChanged,
    project.projectId,
    t,
    trimmedDisplayName,
    trimmedPath,
  ]);

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <Settings2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.projectSettings.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isSaving}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('projectWizard.projectSettings.displayName')}
            </label>
            <Input
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full"
              disabled={isSaving}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('projectWizard.projectSettings.displayNameHelp')}
            </p>
          </div>

          {groups.length > 0 && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('sidebar:groups.field', { defaultValue: 'Group' })}
              </label>
              <select
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
                disabled={isSaving}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">{t('sidebar:groups.ungrouped', { defaultValue: 'Ungrouped' })}</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {t('sidebar:groups.fieldHelp', {
                  defaultValue: 'Groups only change how the sidebar is organized — no folders are moved.',
                })}
              </p>
            </div>
          )}

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('projectWizard.projectSettings.path')}
            </label>

            <WorkspacePathField
              value={projectPath}
              disabled={isSaving}
              onChange={setProjectPath}
            />

            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('projectWizard.projectSettings.pathHelp')}
            </p>

            {pathChanged && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/20">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 space-y-1">
                  <p className="break-all font-mono text-xs text-amber-900 dark:text-amber-100">
                    {originalPath} → {trimmedPath}
                  </p>
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    {t('projectWizard.projectSettings.pathWarning')}
                  </p>
                </div>
              </div>
            )}
          </div>

          <MediaFoldersField
            folders={mediaFolders}
            disabled={isSaving}
            onChange={setMediaFolders}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 p-6 dark:border-gray-700">
          <Button
            variant="ghost"
            className="mr-auto text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
            onClick={onRequestDelete}
            disabled={isSaving}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('sidebar:projects.deleteProject')}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {t('projectWizard.projectSettings.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('projectWizard.projectSettings.saving')}
              </>
            ) : (
              t('projectWizard.projectSettings.save')
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
