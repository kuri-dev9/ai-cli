import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';

/**
 * 컴포저 팝오버는 위로 열린다 — 컴포저가 창 맨 아래라 위에는 자리가 늘 있고
 * 아래에는 없기 때문이다.
 *
 * 그런데 같은 메뉴를 창 위쪽에 붙은 띠에서도 쓴다. 룸의 참가자 설정이 그렇다.
 * 거기서 위로 열면 메뉴가 창 위로 넘어가 잘린다 — 모델을 고르려다 목록의 첫
 * 줄부터 보이지 않는다. 위가 비좁고 아래가 더 넓으면 반대로 열려야 한다.
 */

/** 주어진 위치에 트리거 버튼이 있는 것처럼 꾸민 훅. */
function anchorFor(rect: { top: number; bottom: number; right: number }) {
  const { result } = renderHook(() => useComposerMenuAnchor(false, () => {}));
  const trigger = {
    getBoundingClientRect: () => ({ ...rect, left: rect.right - 80, width: 80, height: rect.bottom - rect.top }),
  } as unknown as HTMLButtonElement;
  result.current.triggerRef.current = trigger;
  act(() => result.current.updateAnchor());
  return result.current.anchor;
}

test('a trigger near the bottom opens the menu upward', () => {
  // 창 높이 768 기준, 컴포저의 모델 버튼쯤 되는 자리.
  window.innerHeight = 768;
  window.innerWidth = 1280;
  const anchor = anchorFor({ top: 700, bottom: 728, right: 400 });

  assert.equal(anchor?.top, undefined, '위로 열 때는 top 을 쓰지 않는다');
  assert.equal(anchor?.bottom, 768 - 700 + 8);
  // 위에 남은 자리만큼 높아질 수 있다.
  assert.equal(anchor?.maxHeight, 700 - 8 - 8);
});

test('a trigger pinned near the top opens the menu downward instead', () => {
  window.innerHeight = 768;
  window.innerWidth = 1280;
  // 룸의 참가자 설정 띠: 헤더 바로 아래라 위에 50px 밖에 없다.
  const anchor = anchorFor({ top: 50, bottom: 78, right: 400 });

  assert.equal(anchor?.bottom, undefined, '아래로 열 때는 bottom 을 쓰지 않는다');
  assert.equal(anchor?.top, 78 + 8, '트리거 바로 아래에서 시작한다');
  // 아래에 남은 자리만큼 높아질 수 있다.
  assert.equal(anchor?.maxHeight, 768 - 78 - 8 - 8);
});

test('a cramped trigger opens into the roomier side and fits inside it', () => {
  // 창이 아주 낮아 위아래 모두 좁다. 그래도 더 넓은 쪽으로 연다.
  window.innerHeight = 240;
  window.innerWidth = 1280;
  const anchor = anchorFor({ top: 150, bottom: 178, right: 400 });

  assert.equal(anchor?.top, undefined);
  assert.equal(anchor?.bottom, 240 - 150 + 8);
  // 자리가 좁으면 메뉴도 그만큼만 높다. 넘쳐서 잘리는 대신 안에서 스크롤한다.
  assert.equal(anchor?.maxHeight, 150 - 8 - 8);
});
