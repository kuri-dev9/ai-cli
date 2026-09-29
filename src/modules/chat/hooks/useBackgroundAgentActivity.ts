import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatMessage, SessionActivity } from '@/shared/types';

/**
 * Builds the status-tab activity for agents still running in the background,
 * or null when there are none. Exported for tests.
 *
 * An async agent keeps working after the turn that launched it reports
 * `complete`, so the session's processing entry is already gone while the
 * agent's card still reads "running". The card is the only place that knows,
 * so the status tab is derived from the same rows rather than tracked apart.
 */
export function deriveBackgroundAgentActivity(
  chatMessages: readonly ChatMessage[],
  describe: (count: number) => string,
): SessionActivity | null {
  const runningAgents = chatMessages.filter(
    (message) => message.isSubagentContainer && message.subagent?.status === 'running',
  );
  if (runningAgents.length === 0) {
    return null;
  }

  // Elapsed time counts from the oldest agent still going, which is how long
  // the session has had work outstanding.
  const launchTimes = runningAgents
    .map((message) => new Date(message.timestamp).getTime())
    .filter((time) => Number.isFinite(time));

  return {
    statusText: describe(runningAgents.length),
    // The turn is over, so there is nothing for the stop button to abort.
    canInterrupt: false,
    startedAt: launchTimes.length > 0 ? Math.min(...launchTimes) : Date.now(),
  };
}

/**
 * Activity for the composer's status tab while background agents outlive their
 * turn. Yields to the live turn's own activity whenever one is in flight.
 */
export function useBackgroundAgentActivity(
  chatMessages: readonly ChatMessage[],
  sessionActivity: SessionActivity | null,
): SessionActivity | null {
  const { t } = useTranslation('chat');

  return useMemo(() => {
    if (sessionActivity) {
      return null;
    }

    return deriveBackgroundAgentActivity(chatMessages, (count) => t('claudeStatus.backgroundAgents', {
      count,
      defaultValue: '{{count}} background agent(s) running',
    }));
  }, [chatMessages, sessionActivity, t]);
}
