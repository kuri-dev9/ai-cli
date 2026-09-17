import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Claude streams token deltas and *then* re-sends the finished assistant
 * message, so the preview bubble the deltas built has to be dropped rather
 * than finalized — otherwise the same reply renders twice. Providers that
 * stream deltas without a follow-up message (Cursor, OpenCode) still rely on
 * finalizeStreaming, so both paths are covered here.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: vi.fn(),
    },
  },
}));

afterEach(() => {
  vi.resetModules();
});

const SESSION = 'session-1';

async function store() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  return renderHook(() => useSessionStore());
}

const finished = (content: string): NormalizedMessage => ({
  id: 'assistant-1',
  kind: 'text',
  role: 'assistant',
  provider: 'claude',
  sessionId: SESSION,
  content,
  timestamp: '2026-01-01T00:00:01.000Z',
  transcriptAnchorId: 'uuid-1',
} as NormalizedMessage);

describe('streaming preview handoff', () => {
  it('drops the preview when the finished message arrives', async () => {
    const view = await store();

    act(() => {
      view.result.current.updateStreaming(SESSION, 'Hello wor', 'claude');
    });
    assert.equal(view.result.current.getMessages(SESSION).length, 1);
    assert.equal(view.result.current.getMessages(SESSION)[0].kind, 'stream_delta');

    act(() => {
      view.result.current.discardStreaming(SESSION);
      view.result.current.appendRealtime(SESSION, finished('Hello world'));
    });

    const messages = view.result.current.getMessages(SESSION);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'text');
    assert.equal(messages[0].content, 'Hello world');
    // The anchor is why the finished message wins: the preview never had one,
    // so keeping it would leave a bubble the user cannot edit or fork from.
    assert.equal(messages[0].transcriptAnchorId, 'uuid-1');
  });

  it('leaves the transcript alone when there is no preview', async () => {
    const view = await store();

    act(() => {
      view.result.current.appendRealtime(SESSION, finished('No deltas here'));
      view.result.current.discardStreaming(SESSION);
    });

    const messages = view.result.current.getMessages(SESSION);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'No deltas here');
  });

  it('still promotes the preview for providers that send deltas only', async () => {
    const view = await store();

    act(() => {
      view.result.current.updateStreaming(SESSION, 'Cursor reply', 'cursor');
      view.result.current.finalizeStreaming(SESSION);
    });

    const messages = view.result.current.getMessages(SESSION);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'text');
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].content, 'Cursor reply');
  });
});
