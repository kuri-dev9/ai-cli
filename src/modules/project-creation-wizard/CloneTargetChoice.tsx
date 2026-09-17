import { useTranslation } from 'react-i18next';
import { AlertTriangle, FolderGit2, FolderInput, FolderOpen } from 'lucide-react';

import type { CloneTargetMode, CloneTargetPreflightResult } from '@/shared/types';

type CloneTargetChoiceProps = {
  preflight: CloneTargetPreflightResult;
  /** 아직 아무것도 고르지 않았으면 null — 그 동안은 생성 버튼이 잠긴다. */
  selectedChoice: CloneTargetChoiceId | null;
  disabled: boolean;
  onChange: (choice: { cloneTarget: CloneTargetMode; skipClone: boolean }) => void;
};

/** 'skip' 은 clone 없이 폴더만 등록, 'subdirectory' 는 하위 폴더에 clone. */
export type CloneTargetChoiceId = 'skip' | 'subdirectory';

const CHOICE_ICONS = {
  skip: FolderOpen,
  subdirectory: FolderInput,
} as const;

/**
 * Rendered by StepReview when the chosen folder already holds files.
 *
 * git clone 은 비어 있지 않은 폴더에 받을 수 없다. 그래서 clone 을 시작하기
 * 전에 "이 폴더를 그대로 프로젝트로 등록" 할지, "하위 폴더에 clone" 할지
 * 사용자에게 먼저 묻는다.
 */
export default function CloneTargetChoice({
  preflight,
  selectedChoice,
  disabled,
  onChange,
}: CloneTargetChoiceProps) {
  const { t } = useTranslation();
  const subdirectoryPath = preflight.subdirectory?.path || '';
  const subdirectoryTaken = Boolean(preflight.subdirectory?.exists);

  const choices: {
    id: CloneTargetChoiceId;
    title: string;
    description: string;
    disabled: boolean;
  }[] = [
    {
      id: 'skip',
      title: t('projectWizard.cloneTarget.skipTitle'),
      description: t('projectWizard.cloneTarget.skipDescription'),
      disabled: false,
    },
    {
      id: 'subdirectory',
      title: t('projectWizard.cloneTarget.subdirectoryTitle', {
        repositoryName: preflight.repositoryName,
      }),
      description: subdirectoryTaken
        ? t('projectWizard.cloneTarget.subdirectoryTaken', { path: subdirectoryPath })
        : t('projectWizard.cloneTarget.subdirectoryDescription', { path: subdirectoryPath }),
      disabled: subdirectoryTaken,
    },
  ];

  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
            {t('projectWizard.cloneTarget.notEmptyTitle', {
              count: preflight.direct.entryCount,
            })}
          </p>
          <p className="break-all font-mono text-xs text-amber-800 dark:text-amber-200">
            {preflight.direct.path}
          </p>
          {preflight.direct.sampleEntries.length > 0 && (
            <p className="break-all text-xs text-amber-800 dark:text-amber-200">
              {preflight.direct.sampleEntries.join(', ')}
              {preflight.direct.entryCount > preflight.direct.sampleEntries.length && ' …'}
            </p>
          )}
          {preflight.direct.hasGitRepository && (
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
              <FolderGit2 className="h-3.5 w-3.5" />
              {t('projectWizard.cloneTarget.alreadyGitRepository')}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {choices.map((choice) => {
          const Icon = CHOICE_ICONS[choice.id];
          const isSelected = selectedChoice === choice.id;

          return (
            <button
              key={choice.id}
              type="button"
              disabled={disabled || choice.disabled}
              onClick={() =>
                onChange(
                  choice.id === 'skip'
                    ? { cloneTarget: 'direct', skipClone: true }
                    : { cloneTarget: 'subdirectory', skipClone: false },
                )
              }
              className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected
                  ? 'border-blue-500 bg-white dark:border-blue-400 dark:bg-gray-800'
                  : 'border-gray-200 bg-white/60 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800/60 dark:hover:border-gray-600'
              }`}
            >
              <Icon
                className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                  isSelected
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-400 dark:text-gray-500'
                }`}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-gray-900 dark:text-white">
                  {choice.title}
                </span>
                <span className="mt-0.5 block break-all text-xs text-gray-600 dark:text-gray-400">
                  {choice.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-amber-800 dark:text-amber-200">
        {t('projectWizard.cloneTarget.cancelHint')}
      </p>
    </div>
  );
}
