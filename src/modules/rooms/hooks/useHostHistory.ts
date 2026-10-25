import { useCallback, useState } from 'react';

import { api } from '@/shared/api';
import type { NormalizedMessage } from '@/shared/types';
import { selectPreRoomMessages } from '@/modules/rooms/utils/roomHistory';

type HostHistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; messages: NormalizedMessage[] }
  | { status: 'error'; error: string };

/**
 * The host session's conversation from before the room existed. Fetched on
 * demand, the first time the room view expands it, so opening a room does not
 * pay for a transcript the user may never look at.
 */
export function useHostHistory(hostSessionId: string, roomCreatedAt: string | null) {
  const [state, setState] = useState<HostHistoryState>({ status: 'idle' });

  const load = useCallback(async () => {
    if (!roomCreatedAt) return;
    setState({ status: 'loading' });
    try {
      const response = await api.providers.sessionMessages(hostSessionId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data ?? body;
      const messages: NormalizedMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      setState({ status: 'loaded', messages: selectPreRoomMessages(messages, roomCreatedAt) });
    } catch (error) {
      setState({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }, [hostSessionId, roomCreatedAt]);

  return { state, load };
}
