import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  findTranscriptContentElement,
  resolveFollowIntent,
} from '@/modules/chat/hooks/useChatSessionState';

/**
 * 스트리밍 중 바닥 따라가기의 두 재료.
 *
 * - 휠/터치 방향으로 따라가기를 놓고 다시 붙는 판정. `scroll` 이벤트용 8px
 *   선과 달리 방향이 있는 입력은 의도가 분명하므로 더 관대하게 붙는다.
 * - ResizeObserver 가 지켜볼 본문 요소 선택. 내보내기 메뉴(sticky) 래퍼가
 *   첫 자식으로 끼어들면서 firstElementChild 를 관찰하던 코드가 스트리밍
 *   성장(메시지 개수는 그대로, 마지막 메시지만 길어짐)을 통째로 놓쳤다.
 */

test('휠을 위로 굴리면 어디에 있든 따라가기를 놓는다', () => {
  assert.equal(resolveFollowIntent(-1, 0), 'release');
  assert.equal(resolveFollowIntent(-120, 3000), 'release');
});

test('휠을 아래로 굴려 바닥 근처에 오면 다시 따라간다', () => {
  assert.equal(resolveFollowIntent(100, 0), 'follow');
  assert.equal(resolveFollowIntent(100, 119), 'follow');
});

test('바닥에서 멀리 떨어진 채 아래로 굴리는 것은 그냥 읽어 내려가는 것이다', () => {
  assert.equal(resolveFollowIntent(100, 800), null);
  assert.equal(resolveFollowIntent(0, 0), null);
});

test('본문 표식이 있으면 첫 자식(내보내기 메뉴 래퍼)이 아니라 본문을 관찰한다', () => {
  const container = document.createElement('div');

  const exportMenuWrapper = document.createElement('div');
  container.appendChild(exportMenuWrapper);

  const content = document.createElement('div');
  content.setAttribute('data-chat-scroll-content', '');
  container.appendChild(content);

  assert.equal(findTranscriptContentElement(container), content);
});

test('표식이 없으면 예전처럼 첫 자식으로, 그마저 없으면 컨테이너로 물러난다', () => {
  const container = document.createElement('div');
  assert.equal(findTranscriptContentElement(container), container);

  const onlyChild = document.createElement('div');
  container.appendChild(onlyChild);
  assert.equal(findTranscriptContentElement(container), onlyChild);
});
