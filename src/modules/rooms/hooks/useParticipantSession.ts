import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types';
import { useSessionTokenUsage } from '@/modules/rooms/hooks/useSessionTokenUsage';

type SessionSelection = { model: string | null; effort: string | null };

/**
 * One room participant's session settings: its model and reasoning effort
 * (read from and written to the session, which the room's turns run with) and
 * its context-window usage, reloaded whenever `refreshKey` changes.
 *
 * Talks to the session endpoints directly rather than through chat's provider
 * state, which also switches the app-wide selected provider as a side effect.
 */
export function useParticipantSession(provider: string, sessionId: string, refreshKey: number) {
  // The provider's model list, which also says which efforts each model takes.
  const [catalog, setCatalog] = useState<ProviderModelsDefinition | null>(null);
  // What the session itself records; null fields fall back to the catalog default.
  const [selection, setSelection] = useState<SessionSelection>({ model: null, effort: null });
  const tokenUsage = useSessionTokenUsage(sessionId, refreshKey);

  useEffect(() => {
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

  const model = selection.model ?? catalog?.DEFAULT ?? '';
  const modelOptions = useMemo(() => catalog?.OPTIONS ?? [], [catalog]);
  const effortOptions = useMemo<NonNullable<ProviderModelOption['effort']>['values']>(
    () => modelOptions.find((option) => option.value === model)?.effort?.values ?? [],
    [model, modelOptions],
  );
  // An effort the newly picked model does not take reads as the default.
  const effort = selection.effort && effortOptions.some((option) => option.value === selection.effort)
    ? selection.effort
    : DEFAULT_EFFORT_VALUE;

  const selectModel = useCallback(async (nextModel: string) => {
    const response = await api.providers.setSessionActiveModel(provider, sessionId, nextModel);
    const body = await readApiJson<{ data?: { model?: string } }>(response);
    setSelection((current) => ({ ...current, model: body.data?.model?.trim() || nextModel }));
  }, [provider, sessionId]);

  const selectEffort = useCallback(async (nextEffort: string) => {
    const response = await api.providers.setSessionActiveEffort(provider, sessionId, nextEffort);
    const body = await readApiJson<{ data?: { effort?: string } }>(response);
    setSelection((current) => ({ ...current, effort: body.data?.effort?.trim() || nextEffort }));
  }, [provider, sessionId]);

  return {
    model,
    modelOptions,
    modelsLoading: catalog === null,
    effort,
    effortOptions,
    selectModel,
    selectEffort,
    tokenUsage,
  };
}
