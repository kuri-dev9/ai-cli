import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage } from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};

type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  /**
   * 세션 id → 지금까지 모인 스트리밍 텍스트와 그 세션의 provider.
   *
   * provider 를 같이 들고 다니는 이유는, flush 할 때 보고 있는 세션의 provider
   * 를 다른 세션 것에도 붙여 버리면 Codex 세션의 답이 Claude 것으로 기록되기
   * 때문이다.
   */
  accumulatedStreamRef: MutableRefObject<Map<string, { text: string; provider: LLMProvider }>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  /**
   * 브라우저 밖에서(텔레그램·예약 메시지) 이 세션의 턴이 막 시작됐다.
   *
   * 그 턴의 이벤트는 아직 이 소켓으로 오지 않는다. 구독해서 붙어야 내용도,
   * 승인 요청도 이쪽으로 흐른다 — 붙지 않으면 화면은 표시등만 돌고, 승인은
   * 아무에게도 닿지 못한 채 시간이 지나 거부로 끝난다.
   */
  onExternalRunStarted?: (sessionId: string) => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  streamTimerRef,
  accumulatedStreamRef,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  onExternalRunStarted,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const stampedSessionId = typeof msg.sessionId === 'string' && msg.sessionId ? msg.sessionId : null;
      const sid = stampedSessionId || activeViewSessionId;

      /*
       * 세션 이름표가 없는 프레임을 "지금 보고 있는 세션" 것으로 떠넘기지 않는다.
       *
       * 이 폴백은 세션이 하나일 때만 안전했다. 두 세션이 동시에 돌면, 이름표가
       * 빠진 프레임이 도착하는 순간 남의 답변이 내 대화창에 그려진다 — 주식
       * 프로젝트의 답이 웹 UI 대화 한가운데 끼어드는 식으로. 어느 세션 것인지
       * 모르는 내용은 엉뚱한 곳에 그리느니 버리는 편이 낫다.
       *
       * 상태·권한·게이트웨이 이벤트는 대화 내용을 만들지 않으므로 폴백을 그대로
       * 둔다. 세션 id 가 아직 없는 새 대화의 첫 프레임이 여기에 해당한다.
       */
      const CONTENT_KINDS = new Set([
        'text',
        'stream_delta',
        'stream_end',
        'thinking',
        'tool_use',
        'tool_result',
        'error',
        'task_notification',
      ]);
      if (!stampedSessionId && CONTENT_KINDS.has(msg.kind)) {
        console.warn('[Chat] Dropped an unlabeled content frame', { kind: msg.kind });
        return;
      }

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'run_state': {
          // 브라우저 밖에서 시작된 턴(텔레그램·예약 메시지)의 실행 여부 알림.
          // 이 경로는 화면이 요청하지 않은 턴이라 `chat_subscribed` 의 stale
          // 가드를 쓰지 않는다 — 비교할 "내가 보낸 요청 시각"이 없다.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
            // 서버는 이 실행을 아직 보고 있지 않은 화면에만 이 프레임을 보낸다.
            // 그러니 받았다는 것은 "붙어 있지 않다"는 뜻이고, 지금 보고 있는
            // 대화라면 붙어야 한다 — 보낸 글과 승인 요청이 그때부터 온다.
            if (sid === activeViewSessionId) {
              onExternalRunStarted?.(sid);
            }
          } else {
            onSessionIdle?.(sid);
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      // --- Streaming: buffer for performance ---
      if (msg.kind === 'stream_delta') {
        const text = (msg.content as string) || '';
        if (!text || !sid) return;

        // 보고 있는 세션이든 아니든 똑같이 이 버퍼로 모은다. 예전에는 비활성
        // 세션의 조각만 `appendRealtime` 으로 흘려보냈는데, 그러면 조각 하나가
        // 곧 메시지 하나가 되어 "Now the / textarea height / cap and ..." 처럼
        // 한 문장이 여러 블록으로 쪼개진 채 남았다.
        const buffered = accumulatedStreamRef.current.get(sid);
        accumulatedStreamRef.current.set(sid, {
          text: (buffered?.text ?? '') + text,
          // 프레임이 스스로 밝힌 provider 가 가장 정확하다.
          provider: (msg.provider as LLMProvider) ?? buffered?.provider ?? provider,
        });

        if (!streamTimerRef.current) {
          streamTimerRef.current = window.setTimeout(() => {
            streamTimerRef.current = null;
            // 한 타이머로 모든 세션을 한꺼번에 flush 한다.
            for (const [bufferedSessionId, entry] of accumulatedStreamRef.current) {
              sessionStore.updateStreaming(bufferedSessionId, entry.text, entry.provider);
            }
          }, 100);
        }
        return;
      }

      if (msg.kind === 'stream_end') {
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid) {
          const pending = accumulatedStreamRef.current.get(sid);
          if (pending?.text) {
            sessionStore.updateStreaming(sid, pending.text, pending.provider);
          }
          sessionStore.finalizeStreaming(sid);
          accumulatedStreamRef.current.delete(sid);
        }
        return;
      }

      // Claude sends token deltas *and* then the finished assistant message, so
      // the preview bubble the deltas built is about to be superseded by the
      // real one. Drop it rather than finalizing it, and stop the pending flush
      // so a late timer cannot resurrect it after the real message lands.
      // Providers that stream deltas without a follow-up message never reach
      // here with an assistant text, and keep the stream_end path above.
      if (sid && msg.kind === 'text' && msg.role === 'assistant') {
        if (streamTimerRef.current) {
          clearTimeout(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        accumulatedStreamRef.current.delete(sid);
        sessionStore.discardStreaming(sid);
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Flush any remaining streaming state
          if (streamTimerRef.current) {
            clearTimeout(streamTimerRef.current);
            streamTimerRef.current = null;
          }
          if (sid) {
            const pending = accumulatedStreamRef.current.get(sid);
            if (pending?.text) {
              sessionStore.updateStreaming(sid, pending.text, pending.provider);
              sessionStore.finalizeStreaming(sid);
            }
            accumulatedStreamRef.current.delete(sid);
          }

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (msg.text && sid) {
            onSessionProcessing?.(sid, {
              statusText: msg.text as string,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    return subscribe(handleEvent);
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    onExternalRunStarted,
    requestLatestMessages,
    sessionStore,
  ]);
}
