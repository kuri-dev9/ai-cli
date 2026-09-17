import { useCallback, useMemo, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import StepConfiguration from '@/modules/project-creation-wizard/StepConfiguration';
import StepReview from '@/modules/project-creation-wizard/StepReview';
import WizardFooter from '@/modules/project-creation-wizard/WizardFooter';
import WizardProgress from '@/modules/project-creation-wizard/WizardProgress';
import { useGithubTokens } from '@/modules/project-creation-wizard/hooks/useGithubTokens';
import {
  cloneWorkspaceWithProgress,
  createProjectRequest,
  fetchClonePreflight,
} from '@/modules/project-creation-wizard/utils/workspaceApi';
import { isCloneWorkflow, shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type {
  CloneTargetMode,
  CloneTargetPreflightResult,
  TokenMode,
  WizardFormState,
  WizardStep,
} from '@/shared/types';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void;
};

const initialFormState: WizardFormState = {
  workspacePath: '',
  githubUrl: '',
  tokenMode: 'stored',
  selectedGithubToken: '',
  newGithubToken: '',
  cloneTarget: 'direct',
  skipClone: false,
};

/** Rendered by the sidebar module's modal layer to create a new project or clone one from GitHub. */
export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<WizardStep>(1);
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloneProgress, setCloneProgress] = useState('');
  const [preflight, setPreflight] = useState<CloneTargetPreflightResult | null>(null);
  const [isInspectingTarget, setIsInspectingTarget] = useState(false);

  const shouldLoadTokens =
    step === 1 && shouldShowGithubAuthentication(formState.githubUrl);

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedGithubToken: tokenId }));
  }, []);

  const {
    tokens: availableTokens,
    loading: loadingTokens,
    loadError: tokenLoadError,
    selectedTokenName,
  } = useGithubTokens({
    shouldLoad: shouldLoadTokens,
    selectedTokenId: formState.selectedGithubToken,
    onAutoSelectToken: autoSelectToken,
  });

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const updateTokenMode = useCallback(
    (tokenMode: TokenMode) => updateField('tokenMode', tokenMode),
    [updateField],
  );

  const handleNext = useCallback(async () => {
    setError(null);

    if (step !== 1) {
      return;
    }

    if (!formState.workspacePath.trim()) {
      setError(t('projectWizard.errors.providePath'));
      return;
    }

    if (!isCloneWorkflow(formState.githubUrl)) {
      setPreflight(null);
      setStep(2);
      return;
    }

    // clone 은 대상 폴더를 건드리기 전에 그 안에 무엇이 있는지 먼저 확인한다.
    setIsInspectingTarget(true);
    try {
      const inspection = await fetchClonePreflight(formState.workspacePath, formState.githubUrl);
      setPreflight(inspection);
      // 지정한 폴더 자체가 저장소 루트다. 폴더가 비어 있지 않으면 확인 화면이
      // 선택지를 띄우고, 사용자가 고를 때까지 'direct' 인 채로 진행이 막힌다.
      setFormState((previous) => ({ ...previous, cloneTarget: 'direct', skipClone: false }));
      setStep(2);
    } catch (inspectionError) {
      setError(
        inspectionError instanceof Error
          ? inspectionError.message
          : t('projectWizard.errors.failedToInspect'),
      );
    } finally {
      setIsInspectingTarget(false);
    }
  }, [formState.githubUrl, formState.workspacePath, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    // 경로나 URL 이 바뀌면 조사 결과가 더 이상 맞지 않는다.
    setPreflight(null);
    setFormState((previous) => ({ ...previous, cloneTarget: 'direct', skipClone: false }));
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  const handleCloneTargetChange = useCallback(
    (choice: { cloneTarget: CloneTargetMode; skipClone: boolean }) => {
      setError(null);
      setFormState((previous) => ({ ...previous, ...choice }));
    },
    [],
  );

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setCloneProgress('');

    try {
      const shouldCloneRepository = isCloneWorkflow(formState.githubUrl) && !formState.skipClone;

      if (shouldCloneRepository) {
        const project = await cloneWorkspaceWithProgress(
          {
            workspacePath: formState.workspacePath,
            githubUrl: formState.githubUrl,
            tokenMode: formState.tokenMode,
            selectedGithubToken: formState.selectedGithubToken,
            newGithubToken: formState.newGithubToken,
            cloneTarget: formState.cloneTarget,
          },
          {
            onProgress: setCloneProgress,
          },
        );

        onProjectCreated?.(project);
        onClose();
        return;
      }

      const project = await createProjectRequest({
        path: formState.workspacePath.trim(),
      });

      onProjectCreated?.(project);
      onClose();
    } catch (createError) {
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  }, [formState, onClose, onProjectCreated, t]);

  const shouldCloneRepository = useMemo(
    () => isCloneWorkflow(formState.githubUrl) && !formState.skipClone,
    [formState.githubUrl, formState.skipClone],
  );

  // 폴더가 비어 있지 않으면 사용자가 어떻게 할지 고르기 전에는 진행할 수 없다.
  const isBlockedOnCloneTargetChoice =
    Boolean(preflight?.requiresConfirmation)
    && !formState.skipClone
    && formState.cloneTarget !== 'subdirectory';

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && (
            <StepConfiguration
              workspacePath={formState.workspacePath}
              githubUrl={formState.githubUrl}
              tokenMode={formState.tokenMode}
              selectedGithubToken={formState.selectedGithubToken}
              newGithubToken={formState.newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onGithubUrlChange={(githubUrl) => updateField('githubUrl', githubUrl)}
              onTokenModeChange={updateTokenMode}
              onSelectedGithubTokenChange={(selectedGithubToken) =>
                updateField('selectedGithubToken', selectedGithubToken)
              }
              onNewGithubTokenChange={(newGithubToken) =>
                updateField('newGithubToken', newGithubToken)
              }
              onAdvanceToConfirm={handleNext}
            />
          )}

          {step === 2 && (
            <StepReview
              formState={formState}
              selectedTokenName={selectedTokenName}
              isCreating={isCreating}
              cloneProgress={cloneProgress}
              preflight={preflight}
              isInspectingTarget={isInspectingTarget}
              onCloneTargetChange={handleCloneTargetChange}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          isBusy={isCreating || isInspectingTarget}
          isNextDisabled={isBlockedOnCloneTargetChoice}
          isCloneWorkflow={shouldCloneRepository}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
