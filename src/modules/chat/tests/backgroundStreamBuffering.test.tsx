import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { ServerEvent, ProjectSession, LLMProvider } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * 다른 세션을 보고 있는 동안 도착한 토큰 조각도 한 덩어리로 모아야 한다.
 *
 * 예전에는 보고 있지 않은 세션의 조각만 `appendRealtime` 으로 흘려보냈다.
 * 조각 하나가 곧 메시지 하나가 되는 경로라, 그 세션으로 돌아오면 한 문장이
 * "Now the / textarea height / cap and / ..." 처럼 여러 블록으로 토막 나
 * 있었다. 세션을 오가는 사람에게만 보이던 증상이라 놓치기도 쉽다.
 */

type StreamingCall = { sessionId: string; text: string; provider: string };
type AppendedMessage = { sessionId: string; kind: string; content?: string };

const renderHandlers = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const streamingCalls: StreamingCall[] = [];
  const appended: AppendedMessage[] = [];
  const finalized: string[] = [];

  const sessionStore = {
    updateStreaming: (sessionId: string, text: string, provider: string) => {
      streamingCalls.push({ sessionId, text, provider });
    },
    appendRealtime: (sessionId: string, message: { kind: string; content?: string }) => {
      appended.push({ sessionId, kind: message.kind, content: message.content });
    },
    finalizeStreaming: (sessionId: string) => {
      finalized.push(sessionId);
    },
    discardStreaming: () => {},
  } as unknown as SessionStore;

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: new Map<string, { text: string; provider: LLMProvider }>() },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, streamingCalls, appended, finalized };
};

const delta = (sessionId: string, content: string): ServerEvent => ({
  kind: 'stream_delta',
  sessionId,
  content,
  provider: 'claude',
} as unknown as ServerEvent);

test('배경 세션의 토큰 조각은 개별 메시지로 쌓이지 않는다', () => {
  vi.useFakeTimers();
  const { dispatch, streamingCalls, appended } = renderHandlers();

  dispatch(delta('background-session', 'Now the '));
  dispatch(delta('background-session', 'textarea height '));
  dispatch(delta('background-session', 'cap.'));
  vi.advanceTimersByTime(150);

  // 조각을 메시지로 쌓는 경로는 쓰이지 않아야 한다.
  assert.deepEqual(appended, []);
  // 그리고 합쳐진 한 덩어리로 한 번 갱신된다.
  assert.deepEqual(streamingCalls, [
    { sessionId: 'background-session', text: 'Now the textarea height cap.', provider: 'claude' },
  ]);
  vi.useRealTimers();
});

test('여러 세션이 동시에 스트리밍해도 서로 섞이지 않는다', () => {
  vi.useFakeTimers();
  const { dispatch, streamingCalls } = renderHandlers();

  dispatch(delta('viewed-session', '보고 있는 세션 '));
  dispatch(delta('background-session', '배경 세션 '));
  dispatch(delta('viewed-session', '답변입니다.'));
  dispatch(delta('background-session', '답변입니다.'));
  vi.advanceTimersByTime(150);

  const bySession = new Map(streamingCalls.map((call) => [call.sessionId, call.text]));
  assert.equal(bySession.get('viewed-session'), '보고 있는 세션 답변입니다.');
  assert.equal(bySession.get('background-session'), '배경 세션 답변입니다.');
  vi.useRealTimers();
});

test('스트림이 끝나면 그 세션 버퍼만 비운다', () => {
  vi.useFakeTimers();
  const { dispatch, streamingCalls, finalized } = renderHandlers();

  dispatch(delta('viewed-session', '남아 있어야 하는 글'));
  dispatch(delta('background-session', '끝난 글'));
  dispatch({ kind: 'stream_end', sessionId: 'background-session' } as unknown as ServerEvent);

  assert.deepEqual(finalized, ['background-session']);

  // 끝난 세션의 버퍼가 비워졌다고 보고 있던 세션의 글까지 사라지면 안 된다.
  dispatch(delta('viewed-session', '이 이어집니다.'));
  vi.advanceTimersByTime(150);

  const viewed = streamingCalls.filter((call) => call.sessionId === 'viewed-session').pop();
  assert.equal(viewed?.text, '남아 있어야 하는 글이 이어집니다.');
  vi.useRealTimers();
});

test('세션 이름표가 없는 내용은 보고 있는 대화에 끼어들지 못한다', () => {
  vi.useFakeTimers();
  const { dispatch, streamingCalls, appended } = renderHandlers();

  // 이름표 없이 도착한 답변. 예전에는 "지금 보고 있는 세션" 것으로 둔갑해서,
  // 두 세션을 동시에 돌리면 남의 답이 내 대화창 한가운데 그려졌다.
  dispatch({ kind: 'text', role: 'assistant', content: '다른 세션의 답변' } as unknown as ServerEvent);
  dispatch({ kind: 'stream_delta', content: '다른 세션의 조각' } as unknown as ServerEvent);
  vi.advanceTimersByTime(150);

  assert.deepEqual(appended, []);
  assert.deepEqual(streamingCalls, []);
  vi.useRealTimers();
});

test('이름표가 있으면 보고 있지 않은 세션 것도 제자리에 들어간다', () => {
  vi.useFakeTimers();
  const { dispatch, appended } = renderHandlers();

  dispatch({
    kind: 'text',
    role: 'assistant',
    sessionId: 'background-session',
    content: '배경 세션의 답변',
  } as unknown as ServerEvent);

  assert.equal(appended.length, 1);
  assert.equal(appended[0].sessionId, 'background-session');
  vi.useRealTimers();
});

test('스트리밍 조각은 그 프레임이 밝힌 provider 로 기록된다', () => {
  vi.useFakeTimers();
  const { dispatch, streamingCalls } = renderHandlers();

  // 보고 있는 세션은 claude 지만, 이 조각은 codex 세션 것이다.
  dispatch({
    kind: 'stream_delta',
    sessionId: 'codex-session',
    content: '코덱스 답변',
    provider: 'codex',
  } as unknown as ServerEvent);
  vi.advanceTimersByTime(150);

  assert.equal(streamingCalls[0]?.provider, 'codex');
  vi.useRealTimers();
});
