import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  findTranscriptContentElement,
  resolveFollowIntent,
  resolveScrolledUpAfterScroll,
} from '@/modules/chat/hooks/useChatSessionState';

/**
 * 스트리밍 중 바닥 따라가기의 세 재료.
 *
 * - 휠/터치 방향 읽기. 위로 올리면 결론(놓는다), 아래로 내리는 것은 여기서
 *   판정하지 않는다.
 * - `scroll` 한 번의 판정. 거리만 보면 스트리밍으로 자란 분량이 끼어들므로
 *   직전 위치와 비교해 실제로 움직인 방향을 함께 본다.
 * - ResizeObserver 가 지켜볼 본문 요소 선택. 내보내기 메뉴(sticky) 래퍼가
 *   첫 자식으로 끼어들면서 firstElementChild 를 관찰하던 코드가 스트리밍
 *   성장(메시지 개수는 그대로, 마지막 메시지만 길어짐)을 통째로 놓쳤다.
 */

/** 화면 높이 800 인 컨테이너에서 한 번의 scroll 을 판정한다. */
const judge = (
  wasScrolledUp: boolean,
  previous: { top: number; height: number } | null,
  top: number,
  height: number,
) => resolveScrolledUpAfterScroll({ wasScrolledUp, previous, top, height, clientHeight: 800 });

test('휠을 위로 굴리면 어디에 있든 따라가기를 놓는다', () => {
  assert.equal(resolveFollowIntent(-1), 'release');
  assert.equal(resolveFollowIntent(-120), 'release');
});

test('아래로 굴리는 것은 휠 단계에서 판정하지 않는다', () => {
  assert.equal(resolveFollowIntent(100), null);
  assert.equal(resolveFollowIntent(0), null);
});

test('따라가는 중 큰 덩어리가 붙어 멀어져도 놓지 않는다', () => {
  // 바닥(1200)에 붙어 있었는데 코드 블록이 붙어 높이가 2000 에서 2400 으로.
  // 사용자는 움직이지 않았다.
  assert.equal(judge(false, { top: 1200, height: 2000 }, 1200, 2400), false);
});

test('따라가는 중 사용자가 50px 넘게 올리면 놓는다', () => {
  assert.equal(judge(false, { top: 1200, height: 2000 }, 1100, 2000), true);
  // 올리는 사이 내용이 자라도 위로 움직인 것은 사용자다.
  assert.equal(judge(false, { top: 1200, height: 2000 }, 1150, 2300), true);
});

test('몇 px 올린 정도로는 놓지 않는다', () => {
  assert.equal(judge(false, { top: 1200, height: 2000 }, 1180, 2000), false);
});

test('내용이 줄어 위로 밀려난 것은 사용자가 올린 것이 아니다', () => {
  assert.equal(judge(false, { top: 1200, height: 2000 }, 900, 1800), false);
});

test('놓인 상태에서 위로 움직이면 바닥 근처여도 놓아 둔다', () => {
  // 트랙패드로 몇 px 씩 올리는 중. 아직 바닥 8px 안이지만 올리는 중이다.
  assert.equal(judge(true, { top: 1200, height: 2000 }, 1196, 2000), true);
});

test('놓인 상태에서 중간까지만 내리면 붙지 않는다', () => {
  assert.equal(judge(true, { top: 400, height: 2600 }, 900, 2600), true);
});

test('위쪽 줄이 다시 그려져 scrollTop 이 밀려도 다시 붙지 않는다', () => {
  // 위로 올리는 중에 위쪽 줄들이 실제 높이로 그려져 3000px 늘었다. 브라우저가
  // 보던 자리를 지키려고 scrollTop 을 3000 올렸다 — 아래로 내린 것이 아니다.
  // 직전 높이(4200)로 재면 바닥을 지나친 것처럼 보였다.
  assert.equal(judge(true, { top: 1000, height: 4200 }, 4000, 7200), true);
});

test('위로 굴린 직후 바닥 그대로인 scroll 로는 다시 붙지 않는다', () => {
  // 휠로 놓은 직후, 그 직전에 우리가 바닥으로 내린 것의 scroll 이 도착했다.
  // 위치는 움직이지 않았다 — 여기서 붙으면 위로 굴리는 족족 끌려 내려간다.
  assert.equal(judge(true, { top: 1200, height: 2000 }, 1200, 2000), true);
});

test('지금 바닥 8px 안이면 붙는다', () => {
  assert.equal(judge(true, { top: 1000, height: 2000 }, 1195, 2000), false);
});

test('직전 위치가 없으면 거리만으로 판정한다', () => {
  assert.equal(judge(false, null, 1100, 2000), true);
  assert.equal(judge(false, null, 1180, 2000), false);
  assert.equal(judge(true, null, 1200, 2000), false);
  assert.equal(judge(true, null, 1100, 2000), true);
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
