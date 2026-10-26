import { useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

/**
 * One session's context-window usage, in the shape TokenUsageSummary reads.
 * `refreshKey` reloads it; the room bumps it when a timeline entry lands,
 * which is when a turn has just finished.
 */
export function useSessionTokenUsage(sessionId: string | null, refreshKey: number): Record<string, unknown> | null {
  // The usage last reported for this session; null until loaded or when there is none yet.
  const [tokenUsage, setTokenUsage] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    // A roster member waiting to be called has no session, so nothing to read.
    if (!sessionId) {
      setTokenUsage(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.providers.sessionTokenUsage(sessionId);
        const body = await readApiJson<{ data?: Record<string, unknown> | null }>(response);
        if (!cancelled) setTokenUsage(body.data ?? null);
      } catch {
        // A session with no transcript yet has no usage to show.
        if (!cancelled) setTokenUsage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  return tokenUsage;
}
