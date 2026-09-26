import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexRateLimitService } from '@/modules/providers/services/codex-rate-limit.service.js';

/** 실제 `GET /backend-api/codex/usage` 응답에서 이 서비스가 보는 부분만. */
const usageResponse = (overrides: Record<string, unknown> = {}) => ({
  plan_type: 'plus',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18_000,
      reset_at: 1_790_403_786,
    },
    secondary_window: {
      used_percent: 51,
      limit_window_seconds: 604_800,
      reset_at: 1_790_428_917,
    },
  },
  ...overrides,
});

const authFile = JSON.stringify({
  tokens: { access_token: 'token', account_id: 'account' },
});

function createService(options: {
  usage?: unknown;
  authFile?: string;
  fail?: boolean;
} = {}) {
  let fetchCount = 0;
  let clock = 1_790_400_000_000;
  const service = createCodexRateLimitService({
    readAuthFile: async () => options.authFile ?? authFile,
    fetchUsage: async () => {
      fetchCount += 1;
      if (options.fail) {
        throw new Error('boom');
      }
      return options.usage ?? usageResponse();
    },
    now: () => clock,
  });
  return {
    service,
    fetchCount: () => fetchCount,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

test('창 길이로 Claude 와 같은 이름을 붙인다', async () => {
  const { service } = createService();

  const { windows, planType } = await service.getSnapshot();

  assert.equal(planType, 'plus');
  assert.deepEqual(windows.map((window) => window.type), ['five_hour', 'seven_day']);
  // used_percent 는 0..100 이고 화면은 0..1 을 읽는다.
  assert.equal(windows[0].utilization, 0.12);
  assert.equal(windows[1].utilization, 0.51);
  // reset_at 은 초 단위 epoch.
  assert.equal(windows[0].resetsAt, new Date(1_790_403_786 * 1000).toISOString());
});

test('길이를 모르는 창도 떨구지 않는다', async () => {
  const { service } = createService({
    usage: usageResponse({
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 5, limit_window_seconds: 86_400, reset_at: 0 },
      },
    }),
  });

  const { windows } = await service.getSnapshot();

  assert.equal(windows.length, 1);
  assert.equal(windows[0].type, '1_day');
  // reset_at 이 0 이면 초기화 시각을 말하지 않는다.
  assert.equal(windows[0].resetsAt, null);
});

test('한도에 다가가면 경고로, 막히면 거절로 읽는다', async () => {
  const warning = createService({
    usage: usageResponse({
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 85, limit_window_seconds: 18_000, reset_at: 1 },
      },
    }),
  });
  const rejected = createService({
    usage: usageResponse({
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18_000, reset_at: 1 },
      },
    }),
  });

  assert.equal((await warning.service.getSnapshot()).windows[0].status, 'allowed_warning');
  assert.equal((await rejected.service.getSnapshot()).windows[0].status, 'rejected');
});

test('연달아 부르면 캐시를 쓰고, 시간이 지나면 다시 묻는다', async () => {
  const harness = createService();

  await harness.service.getSnapshot();
  await harness.service.getSnapshot();
  assert.equal(harness.fetchCount(), 1);

  harness.advance(31_000);
  await harness.service.getSnapshot();
  assert.equal(harness.fetchCount(), 2);
});

test('로그인하지 않았거나 조회에 실패하면 빈 구간으로 답한다', async () => {
  const notLoggedIn = createService({ authFile: '{}' });
  const failing = createService({ fail: true });

  // 한도가 없는 CLI(supported: false)와는 구분한다 — Codex 는 한도가 있는데 못 읽은 것이다.
  assert.deepEqual(await notLoggedIn.service.getSnapshot(), { supported: true, windows: [] });
  assert.deepEqual(await failing.service.getSnapshot(), { supported: true, windows: [] });
});
