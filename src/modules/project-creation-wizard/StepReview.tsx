import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { isSshGitUrl } from '@/modules/project-creation-wizard/utils/pathUtils';
import CloneTargetChoice from '@/modules/project-creation-wizard/CloneTargetChoice';
import type { CloneTargetChoiceId } from '@/modules/project-creation-wizard/CloneTargetChoice';
import type { CloneTargetMode, CloneTargetPreflightResult, WizardFormState } from '@/shared/types';

type StepReviewProps = {
  formState: WizardFormState;
  selectedTokenName: string | null;
  isCreating: boolean;
  cloneProgress: string;
  /** null 이면 아직 대상 폴더를 조사하는 중이거나 clone 작업이 아니다. */
  preflight: CloneTargetPreflightResult | null;
  isInspectingTarget: boolean;
  onCloneTargetChange: (choice: { cloneTarget: CloneTargetMode; skipClone: boolean }) => void;
};

/** Rendered by ProjectCreationWizard as step 2, summarising the chosen configuration and streaming clone progress. */
export default function StepReview({
  formState,
  selectedTokenName,
  isCreating,
  cloneProgress,
  preflight,
  isInspectingTarget,
  onCloneTargetChange,
}: StepReviewProps) {
  const { t } = useTranslation();
  const needsCloneTargetChoice = Boolean(preflight?.requiresConfirmation) && !isCreating;
  const selectedChoice: CloneTargetChoiceId | null = formState.skipClone
    ? 'skip'
    : formState.cloneTarget === 'subdirectory'
      ? 'subdirectory'
      : null;

  const authenticationLabel = useMemo(() => {
    if (formState.tokenMode === 'stored' && formState.selectedGithubToken) {
      return `${t('projectWizard.step3.usingStoredToken')} ${selectedTokenName || t('common:misc.unknownProvider')}`;
    }

    if (formState.tokenMode === 'new' && formState.newGithubToken.trim()) {
      return t('projectWizard.step3.usingProvidedToken');
    }

    if (isSshGitUrl(formState.githubUrl)) {
      return t('projectWizard.step3.sshKey', { defaultValue: 'SSH Key' });
    }

    return t('projectWizard.step3.noAuthentication');
  }, [formState, selectedTokenName, t]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.path')}</span>
            <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
              {formState.workspacePath}
            </span>
          </div>

          {formState.githubUrl && !formState.skipClone && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 dark:text-gray-400">
                {t('projectWizard.step3.cloneInto')}
              </span>
              <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                {formState.cloneTarget === 'subdirectory' && preflight?.subdirectory
                  ? preflight.subdirectory.path
                  : formState.workspacePath}
              </span>
            </div>
          )}

          {formState.githubUrl && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.cloneFrom')}
                </span>
                <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                  {formState.githubUrl}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.authentication')}
                </span>
                <span className="text-xs text-gray-900 dark:text-white">{authenticationLabel}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {isInspectingTarget && (
        <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('projectWizard.cloneTarget.inspecting')}
        </p>
      )}

      {needsCloneTargetChoice && preflight && (
        <CloneTargetChoice
          preflight={preflight}
          selectedChoice={selectedChoice}
          disabled={isCreating}
          onChange={onCloneTargetChange}
        />
      )}

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        {isCreating && cloneProgress ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
              {t('projectWizard.step3.cloningRepository', { defaultValue: 'Cloning repository...' })}
            </p>
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-blue-700 dark:text-blue-300">
              {cloneProgress}
            </code>
          </div>
        ) : (
          <p className="text-sm text-blue-800 dark:text-blue-200">
            {!formState.githubUrl || formState.skipClone
              ? t('projectWizard.step3.newEmpty')
              : t('projectWizard.step3.newWithClone')}
          </p>
        )}
      </div>
    </div>
  );
}
