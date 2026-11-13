import { useTranslation } from 'react-i18next';

import { Input } from '@/shared/ui';
import type { ProjectGroup } from '@/modules/sidebar';

/** 그룹 고르기에서 "새 그룹 만들기"를 뜻하는 값. 실제 그룹 id 와 겹치지 않는다. */
export const NEW_PROJECT_GROUP = '__new__';

type ProjectOptionsFieldsProps = {
  displayName: string;
  /** 표시 이름을 비웠을 때 쓰일 이름(폴더·저장소 이름). */
  defaultName: string;
  groupId: string;
  newGroupName: string;
  starred: boolean;
  groups: ProjectGroup[];
  disabled: boolean;
  onDisplayNameChange: (value: string) => void;
  onGroupIdChange: (value: string) => void;
  onNewGroupNameChange: (value: string) => void;
  onStarredChange: (value: boolean) => void;
};

const selectClassName =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:bg-gray-900/50';

/**
 * 새 프로젝트를 만들면서 함께 정하는 간단한 설정. 만든 뒤 프로젝트 설정
 * 창에서 다시 바꿀 수 있는 것만 둔다.
 */
export default function ProjectOptionsFields({
  displayName,
  defaultName,
  groupId,
  newGroupName,
  starred,
  groups,
  disabled,
  onDisplayNameChange,
  onGroupIdChange,
  onNewGroupNameChange,
  onStarredChange,
}: ProjectOptionsFieldsProps) {
  const { t } = useTranslation(['common', 'sidebar']);

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
        {t('projectWizard.options.title')}
      </h4>

      <div>
        <label htmlFor="project-wizard-display-name" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('projectWizard.projectSettings.displayName')}
        </label>
        <Input
          id="project-wizard-display-name"
          type="text"
          value={displayName}
          placeholder={defaultName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          disabled={disabled}
          className="w-full"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('projectWizard.options.displayNameHelp')}
        </p>
      </div>

      <div>
        <label htmlFor="project-wizard-group" className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('sidebar:groups.field')}
        </label>
        <select
          id="project-wizard-group"
          value={groupId}
          onChange={(event) => onGroupIdChange(event.target.value)}
          disabled={disabled}
          className={selectClassName}
        >
          <option value="">{t('sidebar:groups.ungrouped')}</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
          <option value={NEW_PROJECT_GROUP}>{t('projectWizard.options.newGroup')}</option>
        </select>
        {groupId === NEW_PROJECT_GROUP && (
          <Input
            type="text"
            value={newGroupName}
            placeholder={t('sidebar:groups.namePlaceholder')}
            aria-label={t('sidebar:groups.namePlaceholder')}
            onChange={(event) => onNewGroupNameChange(event.target.value)}
            disabled={disabled}
            className="mt-2 w-full"
            autoFocus
          />
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          type="checkbox"
          checked={starred}
          onChange={(event) => onStarredChange(event.target.checked)}
          disabled={disabled}
          className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
        />
        {t('projectWizard.options.starred')}
      </label>
    </div>
  );
}
