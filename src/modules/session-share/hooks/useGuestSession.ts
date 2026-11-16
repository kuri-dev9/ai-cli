import { useCallback, useEffect, useRef, useState } from 'react';

import { GuestApiError, guestApi } from '@/modules/session-share/guestApi';
import type { GuestLiveEvent, GuestMessage, GuestSnapshot } from '@/modules/session-share/guestApi';

/**
 * 공유 링크 화면의 상태.
 *
 * 게스트는 웹소켓 없이 짧게 물어보며 따라간다. 실행 중에는 자주, 쉬는 동안에는
 * 드물게 묻는다 — 쉬는 동안에도 묻는 이유는 주인이 브라우저에서 시작한 작업도
 * 게스트 화면에 보여야 하기 때문이다.
 *
 * 실행이 끝나면 이어 붙인 조각을 버리고 기록을 다시 읽는다. 조각은 화면을 빨리
 * 그리기 위한 것이고, 기록이 정답이다.
 */

/** 실행 중에 새 조각을 묻는 간격. */
export const ACTIVE_POLL_MS = 1_000;
/** 쉬는 동안 다른 곳에서 시작한 실행이 있는지 묻는 간격. */
export const IDLE_POLL_MS = 5_000;

export type GuestSessionStatus = 'loading' | 'ready' | 'notFound' | 'error';

export type GuestSessionState = {
  status: GuestSessionStatus;
  title: string | null;
  expiresAt: string | null;
  hasMore: boolean;
  /** 기록에 남은 대화. */
  messages: GuestMessage[];
  /** 지금 실행에서 받아 온 확정된 줄들. 끝나면 기록으로 바뀐다. */
  liveMessages: GuestMessage[];
  /** 지금 써지는 중인 답. */
  draft: string;
  /** 보냈지만 아직 실행 스트림에 나타나지 않은 질문. */
  pendingQuestion: string | null;
  isProcessing: boolean;
  awaitingApproval: boolean;
  isSending: boolean;
  sendError: string | null;
  send: (content: string) => Promise<boolean>;
  reload: () => void;
};

type Cursor = { runKey: string | null; afterSeq: number };

export function useGuestSession(token: string): GuestSessionState {
  const [status, setStatus] = useState<GuestSessionStatus>('loading');
  const [snapshot, setSnapshot] = useState<GuestSnapshot | null>(null);
  const [liveMessages, setLiveMessages] = useState<GuestMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const cursorRef = useRef<Cursor>({ runKey: null, afterSeq: 0 });
  const isProcessingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const markProcessing = useCallback((next: boolean) => {
    isProcessingRef.current = next;
    setIsProcessing(next);
  }, []);

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof GuestApiError && error.code === 'SHARE_NOT_FOUND') {
      setStatus('notFound');
      return;
    }
    setStatus((previous) => (previous === 'loading' ? 'error' : previous));
  }, []);

  const loadSnapshot = useCallback(async () => {
    try {
      const next = await guestApi.snapshot(token);
      if (!mountedRef.current) {
        return;
      }
      setSnapshot(next);
      setLiveMessages([]);
      setDraft('');
      setPendingQuestion(null);
      setAwaitingApproval(next.awaitingApproval);
      // 기록에 이미 들어간 부분은 다시 받지 않는다. 지금부터 생기는 조각만 받는다.
      cursorRef.current = { runKey: next.runKey, afterSeq: next.lastSeq };
      markProcessing(next.isProcessing);
      setStatus('ready');
    } catch (error) {
      if (mountedRef.current) {
        handleFailure(error);
      }
    }
  }, [handleFailure, markProcessing, token]);

  const applyEvents = useCallback((events: GuestLiveEvent[]) => {
    if (events.length === 0) {
      return;
    }
    setDraft((previous) => {
      let next = previous;
      for (const event of events) {
        if (event.kind === 'delta') {
          next += event.content;
        } else if (event.kind === 'text' && event.role === 'assistant') {
          // 확정된 답이 오면 써지던 글은 그걸로 대신한다.
          next = '';
        }
      }
      return next;
    });
    const settled = events.filter((event): event is GuestMessage => event.kind !== 'delta');
    if (settled.length > 0) {
      setLiveMessages((previous) => [...previous, ...settled]);
    }
    if (settled.some((event) => event.kind === 'text' && event.role === 'user')) {
      setPendingQuestion(null);
    }
  }, []);

  const poll = useCallback(async () => {
    try {
      const result = await guestApi.events(token, cursorRef.current);
      if (!mountedRef.current) {
        return;
      }
      setAwaitingApproval(result.awaitingApproval);

      if (result.isProcessing) {
        if (!isProcessingRef.current) {
          // 쉬는 동안 다른 곳에서 실행이 시작됐다. 처음부터 받아 온 것이 위에 있다.
          markProcessing(true);
        }
        cursorRef.current = { runKey: result.runKey, afterSeq: result.lastSeq };
        applyEvents(result.events);
        return;
      }

      if (isProcessingRef.current || result.runKey !== cursorRef.current.runKey) {
        // 실행이 끝났다(또는 우리가 보지 못한 새 실행이 이미 끝났다). 기록이 정답이다.
        await loadSnapshot();
      }
    } catch (error) {
      if (mountedRef.current) {
        handleFailure(error);
      }
    }
  }, [applyEvents, handleFailure, loadSnapshot, markProcessing, token]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    if (status !== 'ready') {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      await poll();
      if (!cancelled) {
        timer = setTimeout(() => void tick(), isProcessingRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      }
    };
    timer = setTimeout(() => void tick(), isProcessingRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isProcessing, poll, status]);

  const send = useCallback(async (content: string) => {
    const text = content.trim();
    if (!text || isSending || isProcessingRef.current) {
      return false;
    }
    setIsSending(true);
    setSendError(null);
    try {
      await guestApi.send(token, text);
      if (!mountedRef.current) {
        return true;
      }
      setPendingQuestion(text);
      setLiveMessages([]);
      setDraft('');
      // 새 실행은 처음부터 받는다.
      cursorRef.current = { runKey: null, afterSeq: 0 };
      markProcessing(true);
      return true;
    } catch (error) {
      if (mountedRef.current) {
        if (error instanceof GuestApiError && error.code === 'SHARE_NOT_FOUND') {
          setStatus('notFound');
        } else {
          // 화면이 따로 안내하는 경우는 코드로, 나머지는 서버가 준 말 그대로 넘긴다.
          const known = error instanceof GuestApiError
            && (error.code === 'SHARE_SESSION_BUSY' || error.code === 'SHARE_MESSAGE_TOO_LONG');
          setSendError(known ? (error as GuestApiError).code! : error instanceof Error ? error.message : String(error));
        }
      }
      return false;
    } finally {
      if (mountedRef.current) {
        setIsSending(false);
      }
    }
  }, [isSending, markProcessing, token]);

  const reload = useCallback(() => {
    setStatus('loading');
    void loadSnapshot();
  }, [loadSnapshot]);

  return {
    status,
    title: snapshot?.title ?? null,
    expiresAt: snapshot?.expiresAt ?? null,
    hasMore: snapshot?.hasMore ?? false,
    messages: snapshot?.messages ?? [],
    liveMessages,
    draft,
    pendingQuestion,
    isProcessing,
    awaitingApproval,
    isSending,
    sendError,
    send,
    reload,
  };
}
