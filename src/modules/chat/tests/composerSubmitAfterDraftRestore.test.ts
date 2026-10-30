import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { writeDraftText } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * 엔터와 보내기 버튼이 **함께** 죽는 증상을 지키는 테스트.
 *
 * 두 경로는 서로 다르다 — 엔터는 `handleKeyDown` 을 거치고 버튼은 `onSubmit`
 * 을 바로 부른다. 그래서 둘이 동시에 멎으면 원인은 그 아래, 둘 다 쓰는
 * `handleSubmit` 에 있다. 거기서 보낼 내용을 읽는 곳은 `inputValueRef` 하나뿐
 * 이라, 그 ref 가 화면과 어긋나는 순간 전송 전체가 조용해진다. 아무 일도
 * 일어나지 않고 글은 상자에 그대로 남으니 밖에서는 "먹통"으로만 보인다.
 *
 * ref 를 어긋나게 만든 것은 `restoreDraft` 였다. 순수해야 할 setState updater
 * 안에서 ref 를 함께 썼는데, React 는 bailout 판정을 위해 updater 를 미리
 * 돌리고 버려지는 렌더에서도 돌린다. 그 호출마다 ref 가 옛 값으로 덮였다.
 *
 * 룸이 돌 때 유독 자주 터진 이유도 여기 있다. `subscribeToChatDrafts` 에는
 * 스코프 필터가 없어서, 룸이 참가자 대기 목록을 갱신할 때마다 같은 탭의 모든
 * 입력창이 깨어나 restore 를 돈다. 룸과 무관한 세션에서 증상이 난 것은 남의
 * 알림에 깨어났기 때문이다.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-sending' };
/** 룸이 참가자 대기 목록을 건드릴 때처럼, 이 입력창과 상관없는 스코프. */
const ROOM_SCOPE = 'session-room-host';

type SentFrame = { type?: string; content?: string };

const renderComposer = (sent: SentFrame[]) =>
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
      sendMessage: (message) => { sent.push(message as SentFrame); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );

/** 보내기 버튼이 만드는 것과 같은, preventDefault 만 쓰는 이벤트. */
const clickEvent = () =>
  ({ preventDefault: () => undefined }) as unknown as Parameters<
    ReturnType<typeof renderComposer>['result']['current']['handleSubmit']
  >[0];

const attachTextarea = (view: ReturnType<typeof renderComposer>, value: string) => {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  document.body.appendChild(textarea);
  (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;
  return textarea;
};

beforeEach(() => {
  writeDraftText(SESSION.id, '');
  writeDraftText(ROOM_SCOPE, '');
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('남의 스코프 알림이 쏟아져도 쓰던 글은 그대로 전송된다', async () => {
  const sent: SentFrame[] = [];
  const view = renderComposer(sent);
  attachTextarea(view, '');

  await act(async () => {
    view.result.current.setInput('룸이 도는 동안 쓴 글');
  });

  // 룸이 한 턴 돌 때마다 일어나는 일. 스코프 필터가 없어 이 입력창까지 깨운다.
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      writeDraftText(ROOM_SCOPE, `room turn ${i}`);
    }
  });

  assert.equal(view.result.current.input, '룸이 도는 동안 쓴 글', '글상자가 비면 안 된다');

  await act(async () => {
    await view.result.current.handleSubmit(clickEvent());
  });

  assert.equal(sent.length, 1, '보내기가 조용히 중단되면 안 된다');
  assert.equal(sent[0]?.content, '룸이 도는 동안 쓴 글');
});

test('ref 가 비어 있어도 글상자에 보이는 글이 있으면 그것을 보낸다', async () => {
  const sent: SentFrame[] = [];
  const view = renderComposer(sent);

  // 어긋남을 그대로 만든다: ref 는 비어 있고(초기값) 글상자에는 글이 있다.
  // 어떤 경로로 ref 가 비든, 보이는 글을 두고 아무 일도 일어나지 않는 것이
  // 가장 나쁜 결과다.
  attachTextarea(view, '화면에 보이는 글');

  await act(async () => {
    await view.result.current.handleSubmit(clickEvent());
  });

  assert.equal(sent.length, 1, '엔터와 버튼이 함께 죽는 자리다');
  assert.equal(sent[0]?.content, '화면에 보이는 글');
});

test('정말로 빈 상자는 아무것도 보내지 않는다', async () => {
  const sent: SentFrame[] = [];
  const view = renderComposer(sent);
  attachTextarea(view, '');

  await act(async () => {
    await view.result.current.handleSubmit(clickEvent());
  });

  assert.equal(sent.length, 0);
});

test('남의 스코프 변경은 이 입력창을 아예 깨우지 않는다', async () => {
  const sent: SentFrame[] = [];
  const view = renderComposer(sent);
  attachTextarea(view, '');

  // 이 세션에 저장돼 있던 옛 글.
  writeDraftText(SESSION.id, '저장된 옛 글');

  // 포커스는 일부러 주지 않는다 — 타이핑 가드에 가려지면 스코프를 거르는지
  // 알 수 없다. 그리고 둘을 한 act 에 묶어, 방금 친 글이 저장되기 전에 알림이
  // 닿는 순간을 만든다. 스코프를 가리지 않던 때는 여기서 '저장된 옛 글' 로
  // 되돌아갔다 — 룸이 한 차례 돌 때마다 벌어지던 일이다.
  await act(async () => {
    view.result.current.setInput('지금 쓰고 있는 글');
    writeDraftText(ROOM_SCOPE, '룸 참가자 대기 목록 갱신');
  });

  assert.equal(view.result.current.input, '지금 쓰고 있는 글');
});
