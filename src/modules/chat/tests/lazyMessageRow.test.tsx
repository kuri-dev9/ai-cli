import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { act, render } from '@testing-library/react';

import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';

/**
 * Drivable IntersectionObserver stand-in: jsdom has none, so these tests
 * install one and fire its callback by hand to walk a row through the
 * near-viewport / far-away transitions.
 */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    StubIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect(): void {
    this.observed = [];
  }
}

function fireIntersection(
  observer: StubIntersectionObserver,
  target: Element,
  isIntersecting: boolean,
  rect: { width: number; height: number } = { width: 100, height: 40 },
): void {
  act(() => {
    observer.callback(
      [{ target, isIntersecting, boundingClientRect: rect } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

function Harness({
  initiallyNearViewport,
  keepMounted,
}: {
  initiallyNearViewport: boolean;
  keepMounted?: boolean;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  return (
    <div ref={scrollContainerRef}>
      <LazyMessageRow
        lazyRows={lazyRows}
        timestamp="2026-01-01T00:00:00.000Z"
        initiallyNearViewport={initiallyNearViewport}
        keepMounted={keepMounted}
      >
        <span data-testid="row-content">expensive content</span>
      </LazyMessageRow>
    </div>
  );
}

afterEach(() => {
  StubIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('LazyMessageRow', () => {
  it('starts far rows as an addressable placeholder instead of mounting content', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { container, queryByTestId } = render(<Harness initiallyNearViewport={false} />);

    expect(queryByTestId('row-content')).toBeNull();
    const wrapper = container.querySelector('[data-message-timestamp="2026-01-01T00:00:00.000Z"]');
    expect(wrapper).not.toBeNull();
    expect((wrapper as HTMLElement).style.height).not.toBe('');
  });

  it('unmounts to a placeholder of the measured height and remounts when near again', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId } = render(<Harness initiallyNearViewport />);
    expect(queryByTestId('row-content')).not.toBeNull();

    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;
    Object.defineProperty(wrapper, 'offsetHeight', { value: 123, configurable: true });

    fireIntersection(observer, wrapper, false);
    expect(queryByTestId('row-content')).toBeNull();
    expect(wrapper.style.height).toBe('123px');

    fireIntersection(observer, wrapper, true);
    expect(queryByTestId('row-content')).not.toBeNull();
    expect(wrapper.style.height).toBe('');
  });

  it('ignores the zero-rect non-intersections a hidden tab reports', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId } = render(<Harness initiallyNearViewport />);
    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;

    fireIntersection(observer, wrapper, false, { width: 0, height: 0 });

    expect(queryByTestId('row-content')).not.toBeNull();
  });

  it('keeps every row mounted where IntersectionObserver does not exist', () => {
    const { queryByTestId } = render(<Harness initiallyNearViewport={false} />);

    expect(queryByTestId('row-content')).not.toBeNull();
    expect(StubIntersectionObserver.instances).toHaveLength(0);
  });

  it('keeps the live turn mounted off-screen so its height keeps growing', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId, rerender } = render(<Harness initiallyNearViewport keepMounted />);
    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;
    Object.defineProperty(wrapper, 'offsetHeight', { value: 123, configurable: true, writable: true });

    // 스트리밍 중에 사용자가 위로 올려 이 줄이 화면에서 멀어졌다.
    fireIntersection(observer, wrapper, false);
    expect(queryByTestId('row-content')).not.toBeNull();
    expect(wrapper.style.height).toBe('');
    expect(wrapper.hasAttribute('data-live-turn')).toBe(true);

    // 다음 턴이 시작돼 표시가 풀려도, 화면 밖에 있는 동안 자란 높이는 아직
    // 재지 않았으므로 낡은 123px 상자로 줄이지 않는다.
    rerender(<Harness initiallyNearViewport keepMounted={false} />);
    expect(queryByTestId('row-content')).not.toBeNull();
    expect(wrapper.hasAttribute('data-live-turn')).toBe(false);

    // 다시 다가왔다가 멀어질 때 새로 재고서야 빈 상자가 된다.
    Object.defineProperty(wrapper, 'offsetHeight', { value: 456, configurable: true });
    fireIntersection(observer, wrapper, true);
    fireIntersection(observer, wrapper, false);
    expect(queryByTestId('row-content')).toBeNull();
    expect(wrapper.style.height).toBe('456px');
  });
});
