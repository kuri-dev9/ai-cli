/**
 * 프로젝트 행을 끌고 있을 때 목록을 저절로 흐르게 하는 계산.
 *
 * 브라우저가 기본으로 해 주는 드래그 중 가장자리 스크롤은 감지 폭이 몇 픽셀
 * 수준인 데다 중첩 스크롤 컨테이너(사이드바) 안에서는 거의 동작하지 않는다.
 * 그래서 dragover 좌표를 받아 직접 스크롤 속도를 정한다.
 */

/** 포인터가 이 거리(px) 안으로 가장자리에 다가오면 스크롤이 시작된다. */
export const DRAG_SCROLL_EDGE_PX = 56;

/** 가장자리에 바짝 붙었을 때의 프레임당 이동량(px). */
export const DRAG_SCROLL_MAX_STEP_PX = 16;

/**
 * dragover 가 이 시간(ms) 이상 끊기면 드래그가 끝났거나 목록 밖으로 나간
 * 것으로 보고 멈춘다. dragover 는 포인터가 가만히 있어도 수백 ms 간격으로
 * 반복 발생하므로, 이 값이면 드래그 중에 끊길 일은 없다.
 */
export const DRAG_SCROLL_IDLE_MS = 400;

/**
 * 포인터 위치에 대한 프레임당 스크롤 속도.
 *
 * 음수면 위로, 양수면 아래로. 가장자리에 가까울수록 빨라지고, 띠 밖에서는 0.
 * 포인터가 컨테이너를 아예 벗어난 경우(위/아래)도 해당 방향의 최대 속도로
 * 친다 — 끌던 손이 살짝 밖으로 나갔다고 멈추면 더 답답하다.
 */
export function computeDragScrollSpeed(
  pointerY: number,
  containerTop: number,
  containerBottom: number,
): number {
  const fromTop = pointerY - containerTop;
  const fromBottom = containerBottom - pointerY;

  if (fromTop < DRAG_SCROLL_EDGE_PX) {
    const strength = Math.min(1, (DRAG_SCROLL_EDGE_PX - fromTop) / DRAG_SCROLL_EDGE_PX);
    return -Math.max(1, Math.round(strength * DRAG_SCROLL_MAX_STEP_PX));
  }
  if (fromBottom < DRAG_SCROLL_EDGE_PX) {
    const strength = Math.min(1, (DRAG_SCROLL_EDGE_PX - fromBottom) / DRAG_SCROLL_EDGE_PX);
    return Math.max(1, Math.round(strength * DRAG_SCROLL_MAX_STEP_PX));
  }
  return 0;
}

/** 목록을 실제로 담고 있는 가장 가까운 스크롤 조상. 없으면 null. */
export function findScrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}
