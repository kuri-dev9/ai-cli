import { sessionsDb } from '@/modules/database/index.js';
import { ChatSessionWriter } from '@/modules/websocket/services/chat-session-writer.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/services/session-upsert-broadcast.service.js';
import type {
  LLMProvider,
  NormalizedMessage,
  RealtimeClientConnection,
} from '@/shared/types.js';

type ChatRunStatus = 'running' | 'completed';

/**
 * 이 실행을 누가 시작했는지.
 *
 * 텔레그램 브리지가 "결과를 돌려보낼지"를 정하는 유일한 근거다 — 텔레그램에서
 * 시작한 실행은 사용자가 답을 기다리고 있으므로 무조건 회신하고, 웹에서 시작한
 * 실행은 명시적으로 켠 경우에만 보낸다. 출처를 모르면 둘을 구분할 수 없어서
 * 브라우저에서 대화할 때마다 폰이 울린다.
 *
 * 타이머(예약·대기열)에서 시작한 실행처럼 사람이 텔레그램으로 부른 것이 아닌
 * 모든 경우는 `web` 으로 본다. 기본이 조용한 쪽이어야 안전하다.
 */
export type ChatRunOrigin = 'web' | 'telegram';

/**
 * One live (or recently finished) provider run for a single app session.
 *
 * State notes — why each mutable field is essential:
 * - `providerSessionId`: the provider-native id captured mid-run. The abort
 *   handler needs it to address the provider runtime, and the DB mapping is
 *   written from it so history/resume work after the run.
 * - `status`: drives `chat_subscribed.isProcessing`, prevents double sends
 *   into the same session, and guards the synthetic-complete fallback in the
 *   chat handler (only emitted when a runtime died without completing).
 * - `lastSeq` / `events`: the per-run event log. Every live event gets a
 *   monotonically increasing `seq` and is buffered so a reconnecting client
 *   can replay exactly the events it missed via `chat.subscribe`.
 */
type ChatRun = {
  appSessionId: string;
  provider: LLMProvider;
  /** 이 실행을 시작시킨 곳. 기본은 `web`. */
  origin: ChatRunOrigin;
  /**
   * 이 실행 하나만 바깥(텔레그램)으로 중계해 달라는 일회성 요청.
   *
   * 웹 입력이 `/bot` 으로 시작할 때 켜진다. 실행마다 따로 들고 있어야 한다 —
   * 세션에 저장하면 다음 턴까지 따라가서, 한 번만 받으려던 알림이 계속 온다.
   */
  relayRequested: boolean;
  providerSessionId: string | null;
  status: ChatRunStatus;
  lastSeq: number;
  events: NormalizedMessage[];
  writer: ChatSessionWriter;
  startedAt: number;
  completedAt: number | null;
};

/**
 * How long a completed run stays available for replay. Covers the window
 * between a run finishing and the client refreshing history over REST (for
 * example when the browser tab was asleep while the run completed).
 */
const COMPLETED_RUN_RETENTION_MS = 5 * 60 * 1000;

/**
 * Upper bound on buffered events per run so a very long tool-heavy run cannot
 * grow memory unbounded. When exceeded, the oldest stream deltas are dropped
 * first and only then the oldest events of any kind — a reconnecting client
 * whose `lastSeq` predates the buffer falls back to a REST history refresh,
 * which is always the authoritative source.
 */
const MAX_BUFFERED_EVENTS_PER_RUN = 5000;

/**
 * Active and recently-completed runs keyed by app session id.
 *
 * This map is the single in-memory source of truth for "is something running
 * for this session" — the chat websocket handler, abort path, and subscribe
 * path all consult it instead of asking each provider runtime individually.
 */
const runs = new Map<string, ChatRun>();

function evictRunLater(appSessionId: string): void {
  const timer = setTimeout(() => {
    const run = runs.get(appSessionId);
    if (run && run.status === 'completed') {
      runs.delete(appSessionId);
    }
  }, COMPLETED_RUN_RETENTION_MS);

  // Never keep the process alive just to evict a buffered run.
  timer.unref?.();
}

/**
 * Decorates one outbound live event for a run and records it in the event log.
 *
 * Responsibilities:
 * 1. Remap `sessionId` (and `actualSessionId` on `complete`) to the stable
 *    app session id — provider-native ids never leave the backend.
 * 2. Assign the next `seq` so clients can detect/replay gaps.
 * 3. Buffer the event for `chat.subscribe` replay.
 * 4. Flip the run to `completed` when the terminal `complete` event passes by.
 */
function decorateAndRecordEvent(run: ChatRun, message: NormalizedMessage): NormalizedMessage | null {
  // Exactly-one-complete contract: when a run is aborted the chat handler
  // emits the terminal `complete` immediately, but the killed runtime may
  // still emit its own `complete` from its exit handler moments later.
  // Whichever arrives first wins; the duplicate is dropped here.
  if (message.kind === 'complete' && run.status === 'completed') {
    return null;
  }

  run.lastSeq += 1;

  const outbound: NormalizedMessage = {
    ...message,
    sessionId: run.appSessionId,
    seq: run.lastSeq,
  };

  if (message.kind === 'complete') {
    // The provider may report its own id here; the frontend only ever knows
    // the app id, so the "actual" id is by definition the app id as well.
    outbound.actualSessionId = run.appSessionId;
    run.status = 'completed';
    run.completedAt = Date.now();
    evictRunLater(run.appSessionId);
    notifyRunSettled(run.appSessionId);
  }

  run.events.push(outbound);
  while (run.events.length > MAX_BUFFERED_EVENTS_PER_RUN) {
    // Token deltas are a transient preview: one reply produces thousands of
    // them, and the finished assistant message that follows carries the same
    // text. Evicting the oldest delta first keeps prompts, tool calls and tool
    // results inside the replay window — those a reconnecting client cannot
    // reconstruct from anything but a REST refresh. Only once no delta is left
    // does the buffer fall back to dropping its oldest event.
    const oldestDelta = run.events.findIndex((event) => event.kind === 'stream_delta');
    run.events.splice(oldestDelta >= 0 ? oldestDelta : 0, 1);
  }

  return outbound;
}

/**
 * Notified when a session's run reaches its terminal `complete`.
 *
 * The queued-message dispatcher listens here so a queued turn goes out the
 * moment the turn before it ends. Without this it only left on the next poll,
 * which meant a follow-up could sit for up to half a minute after the session
 * had already gone idle.
 */
const runSettledListeners = new Set<(appSessionId: string) => void>();

/** 반대쪽 신호: 세션에서 턴이 막 시작됐다. 외부 브리지의 "작업 시작" 알림용. */
const runStartedListeners = new Set<(appSessionId: string) => void>();

/**
 * "이 대화를 외부 통로에서 놓아 달라"는 신호.
 *
 * 턴이 아니라 사용자의 의사 표시라서 실행과 함께 오지 않는다 — 브라우저로
 * 돌아와 `/unbot` 만 친 경우처럼 돌릴 턴이 없을 수도 있다. 그래서 실행 신호와
 * 별개의 통로로 둔다.
 *
 * 여기서 브리지를 직접 부르지 않는 이유는 방향 때문이다. 브리지가 이 모듈을
 * 가져다 쓰므로, 이쪽에서 브리지를 부르면 서로 물린다.
 */
const relayReleaseListeners = new Set<(appSessionId: string) => void>();

function notifyRunStarted(appSessionId: string): void {
  for (const listener of runStartedListeners) {
    setImmediate(() => {
      try {
        listener(appSessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] Run-started listener failed', {
          appSessionId,
          error: message,
        });
      }
    });
  }
}

function notifyRunSettled(appSessionId: string): void {
  for (const listener of runSettledListeners) {
    // Deferred: this fires while the terminal event is still being written, and
    // a listener that starts the next run synchronously would re-enter the
    // registry mid-write.
    setImmediate(() => {
      try {
        listener(appSessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ChatRunRegistry] Run-settled listener failed', {
          appSessionId,
          error: message,
        });
      }
    });
  }
}

/**
 * Records the provider-native session id for a run and persists the
 * app-id-to-provider-id mapping so history fetches and future resumes can
 * address the provider transcript.
 *
 * Called from the gateway writer when the runtime either calls
 * `setSessionId(...)` or emits its `session_created` event — whichever
 * happens first wins; later calls with the same id are no-ops.
 */
function recordProviderSessionId(run: ChatRun, providerSessionId: string): void {
  if (!providerSessionId || run.providerSessionId === providerSessionId) {
    return;
  }

  run.providerSessionId = providerSessionId;

  try {
    sessionsDb.assignProviderSessionId(run.appSessionId, providerSessionId);
    void broadcastSessionUpserted(run.appSessionId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ChatRunRegistry] Failed to broadcast canonical session mapping', {
        appSessionId: run.appSessionId,
        providerSessionId,
        error: message,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ChatRunRegistry] Failed to persist provider session id mapping', {
      appSessionId: run.appSessionId,
      providerSessionId,
      error: message,
    });
  }
}

/**
 * Registry of live provider runs keyed by the stable app session id.
 *
 * The registry is what makes the websocket protocol provider-independent:
 * every run gets a `ChatSessionWriter` that remaps provider-native session
 * ids to the app id, assigns `seq` numbers, and buffers events for replay —
 * regardless of which provider runtime produced them.
 */
export const chatRunRegistry = {
  /**
   * Starts tracking a run and returns it, or `null` when a run is already in
   * progress for the session (callers must reject the duplicate send).
   */
  startRun(input: {
    appSessionId: string;
    provider: LLMProvider;
    providerSessionId: string | null;
    /**
     * The socket that asked for this run, or `null` for one nobody is watching
     * — a scheduled message fires with no browser attached. The writer's event
     * buffer still records everything, so a client that subscribes later
     * replays the run from its start.
     */
    connection: RealtimeClientConnection | null;
    userId: string | number | null;
    /** 생략하면 `web`. 텔레그램에서 시작한 턴만 `telegram` 을 넘긴다. */
    origin?: ChatRunOrigin;
    /** 이 실행 하나만 텔레그램으로 중계할지(`/bot` 접두어). */
    relayRequested?: boolean;
  }): ChatRun | null {
    const existing = runs.get(input.appSessionId);
    if (existing && existing.status === 'running') {
      return null;
    }

    const run: ChatRun = {
      appSessionId: input.appSessionId,
      provider: input.provider,
      origin: input.origin ?? 'web',
      relayRequested: input.relayRequested ?? false,
      providerSessionId: input.providerSessionId,
      status: 'running',
      lastSeq: 0,
      events: [],
      writer: null as unknown as ChatSessionWriter,
      startedAt: Date.now(),
      completedAt: null,
    };

    run.writer = new ChatSessionWriter({
      connection: input.connection,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      onProviderSessionId: (providerSessionId) => {
        recordProviderSessionId(run, providerSessionId);
      },
      decorateOutboundEvent: (message) => decorateAndRecordEvent(run, message),
    });

    runs.set(input.appSessionId, run);
    notifyRunStarted(input.appSessionId);
    return run;
  },

  getRun(appSessionId: string): ChatRun | undefined {
    return runs.get(appSessionId);
  },

  /**
   * 이 세션의 마지막(또는 진행 중) 실행이 어디서 시작됐는지와, `/bot` 처럼
   * 한 번만 중계해 달라는 요청이 붙어 있었는지.
   *
   * 완료 알림을 만드는 쪽이 `onRunSettled` 직후에 묻는다. 그 시점의 실행은
   * 아직 보존 창(`COMPLETED_RUN_RETENTION_MS`) 안에 있으므로 답이 있다.
   * 기록이 이미 사라진 세션이면 `null` — 그때는 아무것도 보내지 않는 쪽이
   * 맞다(출처를 모르는 실행을 웹 실행으로 단정해 조용히 넘기는 것과 같다).
   */
  describeRunOrigin(appSessionId: string): { origin: ChatRunOrigin; relayRequested: boolean } | null {
    const run = runs.get(appSessionId);
    if (!run) {
      return null;
    }
    return { origin: run.origin, relayRequested: run.relayRequested };
  },

  isProcessing(appSessionId: string): boolean {
    return runs.get(appSessionId)?.status === 'running';
  },

  listRunningRuns(): Array<{
    sessionId: string;
    provider: LLMProvider;
    startedAt: number;
    lastSeq: number;
  }> {
    return Array.from(runs.values())
      .filter((run) => run.status === 'running')
      .map((run) => ({
        sessionId: run.appSessionId,
        provider: run.provider,
        startedAt: run.startedAt,
        lastSeq: run.lastSeq,
      }));
  },

  /**
   * Adds a websocket connection to a run's live audience.
   *
   * This is the generic replacement for the Claude-only writer reconnect:
   * after a page refresh the new socket subscribes and immediately starts
   * receiving the still-running stream, for every provider.
   *
   * Subscribing does not take the stream away from sockets that were already
   * watching — a session open in two places stays live in both, and the
   * refreshed tab's abandoned socket is dropped when the next event finds it
   * closed. Replay stays per-connection because each client sends its own
   * `lastSeq` with `chat.subscribe`.
   */
  attachConnection(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    if (!run) {
      return false;
    }

    run.writer.updateWebSocket(connection);
    return true;
  },

  /**
   * 이 소켓이 이 세션의 실행을 이미 보고 있는지.
   *
   * 시작 알림을 아직 붙지 않은 화면에만 보내기 위해 쓴다 — 이미 이벤트를 받고
   * 있는 화면에 보내면, 그 화면이 다시 구독하며 방금 본 것을 되받는다.
   */
  isWatchedBy(appSessionId: string, connection: RealtimeClientConnection): boolean {
    const run = runs.get(appSessionId);
    return run ? run.writer.hasConnection(connection) : false;
  },

  /**
   * Returns buffered events with `seq` greater than `afterSeq` for replay.
   *
   * An empty array with `run.lastSeq > afterSeq` not covered by the buffer
   * means the buffer was truncated; the client should refresh over REST.
   */
  replayEvents(appSessionId: string, afterSeq: number): NormalizedMessage[] {
    const run = runs.get(appSessionId);
    if (!run) {
      return [];
    }

    return run.events.filter((event) => typeof event.seq === 'number' && event.seq > afterSeq);
  },

  /**
   * Emits a synthetic terminal `complete` if (and only if) the run is still
   * marked running. Used when a provider runtime throws or resolves without
   * having produced its own terminal event, and by the abort path.
   */
  completeRun(appSessionId: string, opts: { exitCode: number; aborted?: boolean }): void {
    const run = runs.get(appSessionId);
    if (!run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Safety-net variant of `completeRun` scoped to one specific run: a no-op
   * unless `run` is still the session's current, running run. A runtime
   * promise can resolve after its own `complete` already streamed AND a new
   * run has replaced it in the registry (a queued message sends within
   * milliseconds of the previous turn ending) — the session-keyed
   * `completeRun` would terminate that newer run.
   */
  completeRunIfCurrent(run: ChatRun, opts: { exitCode: number; aborted?: boolean }): void {
    if (runs.get(run.appSessionId) !== run || run.status !== 'running') {
      return;
    }

    run.writer.sendComplete(opts);
  },

  /**
   * Subscribes to "this session's run just finished"; returns the unsubscribe.
   */
  onRunSettled(listener: (appSessionId: string) => void): () => void {
    runSettledListeners.add(listener);
    return () => {
      runSettledListeners.delete(listener);
    };
  },

  /**
   * Subscribes to "a run just started on this session"; returns the unsubscribe.
   */
  onRunStarted(listener: (appSessionId: string) => void): () => void {
    runStartedListeners.add(listener);
    return () => {
      runStartedListeners.delete(listener);
    };
  },

  /** 이 세션을 외부 통로에서 놓아 달라고 알린다. */
  releaseRelay(appSessionId: string): void {
    for (const listener of relayReleaseListeners) {
      setImmediate(() => {
        try {
          listener(appSessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[ChatRunRegistry] Relay-release listener failed', {
            appSessionId,
            error: message,
          });
        }
      });
    }
  },

  /**
   * Subscribes to "stop relaying this session"; returns the unsubscribe.
   */
  onRelayReleased(listener: (appSessionId: string) => void): () => void {
    relayReleaseListeners.add(listener);
    return () => {
      relayReleaseListeners.delete(listener);
    };
  },

  /**
   * Test-only escape hatch: clears every tracked run.
   */
  clearAll(): void {
    runs.clear();
  },
};
