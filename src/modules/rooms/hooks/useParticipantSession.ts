import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';
import { useSessionTokenUsage } from '@/modules/rooms/hooks/useSessionTokenUsage';

type SessionSelection = { model: string | null; effort: string | null };

/** 세션이 없는 명단 멤버의 고른 값. 명단에 적어 두면 처음 불릴 때 세션으로 옮겨진다. */
type RosterSelection = SessionSelection & {
  save: (changes: { model?: string; effort?: string; claudeAccountId?: string }) => Promise<void>;
};

/**
 * One room participant's session settings: its model and reasoning effort
 * (read from and written to the session, which the room's turns run with) and
 * its context-window usage, reloaded whenever `refreshKey` changes.
 *
 * Talks to the session endpoints directly rather than through chat's provider
 * state, which also switches the app-wide selected provider as a side effect.
 *
 * 아직 불린 적 없는 명단 멤버는 세션이 없다. 그때는 `roster` 의 값을 보여 주고
 * 고른 것도 그쪽에 저장한다.
 */
export function useParticipantSession(
  provider: string,
  sessionId: string | null,
  refreshKey: number,
  roster: RosterSelection,
) {
  // The provider's model list, which also says which efforts each model takes.
  const [catalog, setCatalog] = useState<ProviderModelsDefinition | null>(null);
  // What the session itself records; null fields fall back to the catalog default.
  const [selection, setSelection] = useState<SessionSelection>({ model: null, effort: null });
  const tokenUsage = useSessionTokenUsage(sessionId, refreshKey);

  useEffect(() => {
    // 세션이 없어도 모델 목록은 있어야 고를 수 있다.
    if (!sessionId) {
      let cancelled = false;
      void (async () => {
        try {
          const response = await api.providers.models(provider);
          const models = await readApiJson<{ data?: { models?: ProviderModelsDefinition } }>(response);
          if (!cancelled) setCatalog(models.data?.models ?? null);
        } catch (error) {
          console.error('Failed to load the participant model list:', error);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    let cancelled = false;
    void (async () => {
      try {
        const [modelsResponse, selectionResponse] = await Promise.all([
          api.providers.models(provider),
          api.providers.sessionActiveModel(provider, sessionId),
        ]);
        const models = await readApiJson<{ data?: { models?: ProviderModelsDefinition } }>(modelsResponse);
        const active = await readApiJson<{ data?: { model?: string; effort?: string | null; source?: string } }>(selectionResponse);
        if (cancelled) return;
        setCatalog(models.data?.models ?? null);
        setSelection({
          // A `default` source means nothing is recorded yet.
          model: active.data?.source !== 'default' ? active.data?.model?.trim() || null : null,
          effort: active.data?.effort?.trim() || null,
        });
      } catch (error) {
        console.error('Failed to load the participant model settings:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, sessionId]);

  const current = sessionId ? selection : { model: roster.model, effort: roster.effort };
  const model = current.model ?? catalog?.DEFAULT ?? '';
  const modelOptions = useMemo(() => catalog?.OPTIONS ?? [], [catalog]);
  const effortOptions = useMemo<NonNullable<ProviderModelOption['effort']>['values']>(
    () => modelOptions.find((option) => option.value === model)?.effort?.values ?? [],
    [model, modelOptions],
  );
  // An effort the newly picked model does not take reads as the default.
  const effort = current.effort && effortOptions.some((option) => option.value === current.effort)
    ? current.effort
    : DEFAULT_EFFORT_VALUE;

  const saveToRoster = roster.save;
  const selectModel = useCallback(async (nextModel: string) => {
    if (!sessionId) {
      await saveToRoster({ model: nextModel });
      return;
    }
    const response = await api.providers.setSessionActiveModel(provider, sessionId, nextModel);
    const body = await readApiJson<{ data?: { model?: string } }>(response);
    setSelection((current) => ({ ...current, model: body.data?.model?.trim() || nextModel }));
  }, [provider, sessionId, saveToRoster]);

  const selectEffort = useCallback(async (nextEffort: string) => {
    if (!sessionId) {
      await saveToRoster({ effort: nextEffort });
      return;
    }
    const response = await api.providers.setSessionActiveEffort(provider, sessionId, nextEffort);
    const body = await readApiJson<{ data?: { effort?: string } }>(response);
    setSelection((current) => ({ ...current, effort: body.data?.effort?.trim() || nextEffort }));
  }, [provider, sessionId, saveToRoster]);

  /**
   * 명단 멤버만 바꿀 수 있다. 세션이 생긴 뒤에는 이 계정으로 그 세션의 Claude
   * transcript 를 찾으므로, 거기서는 호출하지 않는다(호출해도 조용히 무시된다
   * — `updateParticipantSelection` 쪽 서버 가드).
   */
  const selectClaudeAccount = useCallback(async (nextClaudeAccountId: string) => {
    if (sessionId) return;
    await saveToRoster({ claudeAccountId: nextClaudeAccountId });
  }, [sessionId, saveToRoster]);

  return {
    model,
    modelOptions,
    modelsLoading: catalog === null,
    effort,
    effortOptions,
    selectModel,
    selectEffort,
    selectClaudeAccount,
    tokenUsage,
  };
}
