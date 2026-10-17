import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ChatMessage } from '@/shared/types';
import type { LazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';

/**
 * Mounts a transcript row's real content only while the row is near the
 * viewport, and swaps it for a fixed-height placeholder otherwise.
 *
 * The transcript renders every loaded message into the DOM, so "Load all" on a
 * long session used to commit tens of thousands of markdown/tool subtrees at
 * once — a gigabyte-scale tab. The wrapper element here always stays in the
 * DOM (carrying the row's `data-message-timestamp`, so search jumps and scroll
 * anchors keep working against unmounted rows), while the expensive subtree
 * exists only inside a band around the viewport.
 *
 * The placeholder reuses the row's last measured height, so scrolling back
 * through previously seen content changes no scroll geometry at all; rows
 * never yet measured use an estimate and rely on browser scroll anchoring
 * while they settle.
 */

/** Placeholder height for rows that have never been measured. */
const ESTIMATED_ROW_HEIGHT_PX = 100;

type LazyMessageRowProps = {
  lazyRows: LazyRowObserver | null;
  /** Mirrors the row's own `data-message-timestamp`, present even while unmounted. */
  timestamp: ChatMessage['timestamp'] | undefined;
  /**
   * Rows near the tail render their content on first commit so the initial
   * scroll-to-bottom measures real heights; everything older starts as a
   * placeholder and mounts when scrolled toward.
   */
  initiallyNearViewport: boolean;
  /**
   * 지금 진행 중인 턴의 줄. 화면 밖에 있어도 내용을 빼지 않는다.
   *
   * 빈 상자는 화면을 벗어난 순간의 높이를 그대로 쓴다. 스트리밍 중인 답은
   * 그 뒤에도 계속 자라므로, 위로 올렸다 내려오면 바닥이 실제보다 가까이
   * 있었다 — 거기 닿는 순간 "바닥에 왔다" 로 읽혀 따라가기가 다시 켜지고,
   * 진짜 높이가 그려지면서 화면이 최하단으로 끌려갔다.
   */
  keepMounted?: boolean;
  children: ReactNode;
};

export default function LazyMessageRow({
  lazyRows,
  timestamp,
  initiallyNearViewport,
  keepMounted = false,
  children,
}: LazyMessageRowProps) {
  const [isNearViewport, setIsNearViewport] = useState(initiallyNearViewport);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  // `keepMounted` 가 풀려도 바로 빈 상자로 바꾸지 않는다. 그 사이 자란 만큼이
  // 지금 기록된 높이에는 없으므로, 다음에 화면을 벗어나며 새로 잴 때까지 붙든다.
  const [isHeld, setIsHeld] = useState(keepMounted);
  if (keepMounted && !isHeld) {
    setIsHeld(true);
  }
  const keepMountedRef = useRef(keepMounted);
  useLayoutEffect(() => {
    keepMountedRef.current = keepMounted;
  }, [keepMounted]);
  const elementRef = useRef<HTMLDivElement | null>(null);

  const handleNearViewportChange = useCallback((nextIsNearViewport: boolean) => {
    if (!nextIsNearViewport) {
      // Measured now, while the content is still in the DOM, so the
      // placeholder that replaces it occupies exactly the same space.
      const height = elementRef.current?.offsetHeight ?? 0;
      if (height > 0) {
        setMeasuredHeight(height);
      }
      if (!keepMountedRef.current) {
        setIsHeld(false);
      }
    }
    setIsNearViewport(nextIsNearViewport);
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!lazyRows || !element) return undefined;
    return lazyRows.observe(element, handleNearViewportChange);
  }, [lazyRows, handleNearViewportChange]);

  const isMounted = lazyRows === null || isNearViewport || keepMounted || isHeld;

  return (
    <div
      ref={elementRef}
      data-message-timestamp={timestamp || undefined}
      data-live-turn={keepMounted || undefined}
      style={isMounted ? undefined : { height: measuredHeight ?? ESTIMATED_ROW_HEIGHT_PX }}
    >
      {isMounted ? children : null}
    </div>
  );
}
