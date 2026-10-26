import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * The token-usage modal offers a cut point: pick an already-sent turn and it,
 * along with everything after it, leaves the conversation.
 *
 * A cut rides the same frame an edit does — `chat.edit-send` with the turn's
 * transcript anchor, which makes the provider resume through the turn before
 * it. What must not blur is the composer state around it: a cut starts from an
 * empty composer (the user picked a point to go back to, not a message to
 * rewrite) and the mode has to reset afterwards so the next ordinary edit does
 * not keep showing the cut wording.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-1' };

type SentMessage = { type: string; anchorId?: string; content?: string };

const renderComposer = (sent: SentMessage[]) =>
  renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => {
        sent.push(message as SentMessage);
      },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

test('arming a cut leaves the composer empty and flags the cut wording', async () => {
  const view = renderComposer([]);

  await act(async () => {
    view.result.current.setInput('half-typed draft');
  });
  await act(async () => {
    view.result.current.beginCutFromAnchor('anchor-7');
  });

  assert.equal(view.result.current.editingAnchorId, 'anchor-7');
  assert.equal(view.result.current.editingMode, 'cut');
  assert.equal(view.result.current.input, '');
});

test('sending after a cut replaces the conversation from that anchor', async () => {
  const sent: SentMessage[] = [];
  const view = renderComposer(sent);

  await act(async () => {
    view.result.current.beginCutFromAnchor('anchor-7');
  });
  await act(async () => {
    view.result.current.setInput('carry on from here');
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  const send = sent.find((message) => message.type === 'chat.edit-send');
  assert.ok(send, 'expected the cut to dispatch a chat.edit-send');
  assert.equal(send.anchorId, 'anchor-7');
  assert.equal(send.content, 'carry on from here');
  // The cut is spent; a plain edit opened next must not inherit its wording.
  assert.equal(view.result.current.editingAnchorId, null);
  assert.equal(view.result.current.editingMode, 'edit');
});

test('cancelling clears an armed cut', async () => {
  const view = renderComposer([]);

  await act(async () => {
    view.result.current.beginCutFromAnchor('anchor-7');
  });
  await act(async () => {
    view.result.current.cancelEditMessage();
  });

  assert.equal(view.result.current.editingAnchorId, null);
  assert.equal(view.result.current.editingMode, 'edit');
});
