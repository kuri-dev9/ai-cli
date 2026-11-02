import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ScheduledMessage } from '@/shared/types';

/** 예약이 이 훅 밖에서(예: `/예약` 명령) 바뀌었을 때 보내는 신호. 화면의 예약 목록이 다시 읽는다. */
const SCHEDULED_MESSAGES_CHANGED = 'ai-cli:scheduled-messages-changed';

export function notifyScheduledMessagesChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SCHEDULED_MESSAGES_CHANGED));
  }
}

/**
 * The messages queued to be sent to one session later.
 *
 * Scheduling is a server-side timer, so this is a plain fetch rather than
 * anything realtime: the list changes only when this client schedules or
 * cancels something, and it is refetched when the session is reopened.
 */
export function useScheduledMessages(sessionId: string | null) {
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessage[]>([]);
  // Which session the list on screen belongs to. A fetch that resolves after
  // the user has moved on must not put the old session's banner on the new one.
  const activeSessionRef = useRef(sessionId);

  const refresh = useCallback(async () => {
    // No session means nothing to fetch; the render-time reset below already
    // cleared whatever the previous session had on screen.
    if (!sessionId) {
      return;
    }

    try {
      const response = await api.scheduledMessages.list(sessionId);
      const payload = await response.json();
      if (activeSessionRef.current !== sessionId) {
        return;
      }
      setScheduledMessages(Array.isArray(payload?.data) ? payload.data : []);
    } catch (error) {
      console.error('Failed to load scheduled messages:', error);
    }
  }, [sessionId]);

  // Cleared during the switch render, not by the fetch that follows: the
  // previous session's banner must never paint over the new session, not even
  // for the frame before an effect could run.
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setScheduledMessages([]);
  }

  useEffect(() => {
    activeSessionRef.current = sessionId;
    void refresh();
  }, [refresh, sessionId]);

  useEffect(() => {
    const handleChange = () => {
      void refresh();
    };
    window.addEventListener(SCHEDULED_MESSAGES_CHANGED, handleChange);
    return () => window.removeEventListener(SCHEDULED_MESSAGES_CHANGED, handleChange);
  }, [refresh]);

  const schedule = useCallback(async (input: {
    content: string;
    scheduledFor: Date;
    options?: Record<string, unknown>;
  }) => {
    if (!sessionId) return false;

    try {
      const response = await api.scheduledMessages.create({
        sessionId,
        content: input.content,
        scheduledFor: input.scheduledFor.toISOString(),
        options: input.options,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await refresh();
      return true;
    } catch (error) {
      console.error('Failed to schedule message:', error);
      return false;
    }
  }, [refresh, sessionId]);

  const cancel = useCallback(async (id: string) => {
    try {
      await api.scheduledMessages.cancel(id);
    } catch (error) {
      console.error('Failed to cancel scheduled message:', error);
    }
    await refresh();
  }, [refresh]);

  return { scheduledMessages, schedule, cancel, refresh };
}
