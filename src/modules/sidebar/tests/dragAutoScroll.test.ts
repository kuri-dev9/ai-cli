import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  DRAG_SCROLL_EDGE_PX,
  DRAG_SCROLL_MAX_STEP_PX,
  computeDragScrollSpeed,
} from '@/modules/sidebar/utils/dragAutoScroll';

/**
 * 드래그 중 자동 스크롤의 속도 계산. 브라우저 기본 가장자리 스크롤이 너무
 * 인색해서 직접 구현한 것이므로, 감지 띠가 충분히 넓고 가장자리에 가까울수록
 * 빨라진다는 성질 자체를 고정해 둔다.
 */

const TOP = 100;
const BOTTOM = 600;

test('가장자리 띠 밖(목록 가운데)에서는 움직이지 않는다', () => {
  assert.equal(computeDragScrollSpeed((TOP + BOTTOM) / 2, TOP, BOTTOM), 0);
  assert.equal(computeDragScrollSpeed(TOP + DRAG_SCROLL_EDGE_PX, TOP, BOTTOM), 0);
  assert.equal(computeDragScrollSpeed(BOTTOM - DRAG_SCROLL_EDGE_PX, TOP, BOTTOM), 0);
});

test('위쪽 띠에서는 위로(음수), 아래쪽 띠에서는 아래로(양수) 흐른다', () => {
  assert.ok(computeDragScrollSpeed(TOP + 10, TOP, BOTTOM) < 0);
  assert.ok(computeDragScrollSpeed(BOTTOM - 10, TOP, BOTTOM) > 0);
});

test('가장자리에 가까울수록 빨라지고, 띠에 막 들어선 곳에서도 최소 1px은 움직인다', () => {
  const nearEdge = computeDragScrollSpeed(TOP + 2, TOP, BOTTOM);
  const nearBand = computeDragScrollSpeed(TOP + DRAG_SCROLL_EDGE_PX - 1, TOP, BOTTOM);
  assert.ok(Math.abs(nearEdge) > Math.abs(nearBand));
  assert.ok(Math.abs(nearBand) >= 1);
});

test('포인터가 컨테이너를 벗어나도 그 방향 최대 속도로 계속 흐른다', () => {
  assert.equal(computeDragScrollSpeed(TOP - 30, TOP, BOTTOM), -DRAG_SCROLL_MAX_STEP_PX);
  assert.equal(computeDragScrollSpeed(BOTTOM + 30, TOP, BOTTOM), DRAG_SCROLL_MAX_STEP_PX);
});
