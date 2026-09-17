import assert from 'node:assert/strict';

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { ConnectionStatusBanner } from '@/shared/ui';

/**
 * 연결이 끊겼다는 사실이 화면에 남아야 한다.
 *
 * 이 배너가 없던 동안은 서버가 죽어도 화면이 그대로여서, "작업이 조용히 끝난
 * 것"과 구별되지 않았다. 여기서 지키는 것은 그 구별이다.
 */

let connected = true;

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ isConnected: connected }),
}));

vi.mock('react-i18next', () => ({
  // 번역 파일이 아니라 배너의 분기만 확인한다. 기본값을 그대로 돌려준다.
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

beforeEach(() => {
  connected = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('연결이 살아 있으면 아무것도 그리지 않는다', () => {
  render(<ConnectionStatusBanner />);
  // 정상 상태를 알리는 배지는 금세 배경이 되어, 정작 끊겼을 때를 못 보게 한다.
  assert.equal(screen.queryByRole('status'), null);
});

test('끊긴 직후의 짧은 공백은 알리지 않는다', () => {
  connected = false;
  render(<ConnectionStatusBanner />);

  // 새로고침 직후에도 소켓이 붙기 전 공백이 있다. 여기서 바로 경고를 띄우면
  // 페이지를 열 때마다 배너가 깜빡인다.
  act(() => { vi.advanceTimersByTime(500); });
  assert.equal(screen.queryByRole('status'), null);
});

test('공백이 길어지면 끊김을 알린다', () => {
  connected = false;
  render(<ConnectionStatusBanner />);

  act(() => { vi.advanceTimersByTime(1000); });
  assert.match(screen.getByRole('status').textContent ?? '', /연결이 끊겼습니다/);
});

test('돌아오면 복귀를 알리고 스스로 사라진다', () => {
  connected = false;
  const view = render(<ConnectionStatusBanner />);
  act(() => { vi.advanceTimersByTime(1000); });

  connected = true;
  view.rerender(<ConnectionStatusBanner />);
  assert.match(screen.getByRole('status').textContent ?? '', /다시 연결되었습니다/);

  // 복귀 안내까지 남아 있으면 그것도 결국 배경이 된다.
  act(() => { vi.advanceTimersByTime(4000); });
  assert.equal(screen.queryByRole('status'), null);
});
