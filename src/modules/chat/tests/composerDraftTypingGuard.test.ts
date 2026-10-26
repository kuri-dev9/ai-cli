import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { writeDraftText } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * `subscribeToChatDrafts` has no scope filter: every draft write anywhere in
 * the tab — another session's composer, a room participant's queue, the server
 * sync — wakes every composer that is listening. Restoring on one of those
 * notifications rewrote the controlled textarea of whoever happened to be
 * typing, putting their box back a keystroke.
 *
 * On a 한글 IME that is worse than losing a character: the restore tears the
 * open composition apart, the browser keeps reporting `isComposing`, and
 * `handleKeyDown` then swallows every Enter. The text sits in the box and
 * nothing sends until the page is reloaded — the bug this guard exists for.
 *
 * So: a notification about ANOTHER scope must not touch a focused composer,
 * and must not touch one with an open composition either.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-typing' };
const OTHER_SCOPE = 'session-somewhere-else';

const renderComposer = () =>
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
      sendMessage: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

/** Stands in for the real textarea so the hook can see focus the way the DOM reports it. */
const attachFocusedTextarea = (view: ReturnType<typeof renderComposer>) => {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;
  textarea.focus();
  return textarea;
};

beforeEach(() => {
  writeDraftText(SESSION.id, '');
  writeDraftText(OTHER_SCOPE, '');
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('another scope\'s draft write leaves a focused composer alone', async () => {
  const view = renderComposer();
  const textarea = attachFocusedTextarea(view);
  assert.equal(textarea.ownerDocument.activeElement, textarea, 'textarea should be focused');

  // Both in ONE act: the notification lands before the persist effect has
  // written '아직 쓰는 중' for this scope, so a restore here reads the stale
  // (empty) stored value — exactly the race that eats the keystroke.
  await act(async () => {
    view.result.current.setInput('아직 쓰는 중');
    writeDraftText(OTHER_SCOPE, 'typed in another conversation');
  });

  assert.equal(view.result.current.input, '아직 쓰는 중');
});

test('an open IME composition is not torn apart by a draft notification', async () => {
  const view = renderComposer();
  // Deliberately NOT focused: composition alone must be enough to hold the
  // restore off, so the guard does not rely on focus bookkeeping being right.
  await act(async () => {
    view.result.current.handleCompositionStart();
    view.result.current.setInput('한글 조합 중');
    writeDraftText(OTHER_SCOPE, 'typed in another conversation');
  });

  assert.equal(view.result.current.input, '한글 조합 중');

  // Once composition ends the composer is restorable again.
  await act(async () => {
    view.result.current.handleCompositionEnd();
  });
  assert.equal(view.result.current.input, '한글 조합 중', 'ending composition must not itself clear the box');
});

test('an idle, unfocused composer still picks up its own scope\'s change', async () => {
  const view = renderComposer();

  await act(async () => {
    writeDraftText(SESSION.id, 'arrived from another device');
  });

  assert.equal(view.result.current.input, 'arrived from another device');
});
