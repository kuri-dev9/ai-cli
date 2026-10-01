import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeUsageService } from '@/modules/providers/services/claude-usage.service.js';
import type { ProviderRateLimitWindow } from '@/shared/types.js';

/** 실제 `GET /api/oauth/usage` 응답에서 이 서비스가 보는 부분만. */
const usageResponse = (overrides: Record<string, unknown> = {}) => ({
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent: 2,
      severity: 'normal',
      resets_at: '2026-09-26T06:09:59.640108+00:00',
      scope: null,
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 22,
      severity: 'normal',
      resets_at: '2026-09-29T08:59:59.640129+00:00',
      scope: null,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 34,
      severity: 'normal',
      resets_at: '2026-09-29T09:00:00.640286+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
  extra_usage: { is_enabled: false },
  ...overrides,
});

function createService(options: {
  usage?: unknown;
  credentials?: { accessToken: string; subscriptionType?: string } | null;
  fail?: boolean;
  /** CLI 로 물러섰을 때 돌아올 창들. 기본은 빈 목록이라 테스트가 CLI 를 띄우지 않는다. */
  cliWindows?: ProviderRateLimitWindow[];
} = {}) {
  let fetchCount = 0;
  let cliCount = 0;
  let clock = 1_790_400_000_000;
  const service = createClaudeUsageService({
    readCredentials: async () =>
      options.credentials === undefined
        ? { accessToken: 'token', subscriptionType: 'max' }
        : options.credentials,
    fetchUsage: async () => {
      fetchCount += 1;
      if (options.fail) {
        throw new Error('boom');
      }
      return options.usage ?? usageResponse();
    },
    readCliUsage: async () => {
      cliCount += 1;
      return { windows: options.cliWindows ?? [] };
    },
    now: () => clock,
  });
  return {
    service,
    fetchCount: () => fetchCount,
    cliCount: () => cliCount,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

test('limits 의 kind 를 이벤트가 쓰던 창 이름으로 옮긴다', async () => {
  const { service } = createService();

  const { windows, planType } = await service.getSnapshot();

  assert.equal(planType, 'max');
  assert.deepEqual(
    windows.map((window) => window.type),
    ['five_hour', 'seven_day', 'seven_day_fable'],
  );
  // percent 는 0..100 이고 화면은 0..1 을 읽는다.
  assert.equal(windows[0].utilization, 0.02);
  assert.equal(windows[2].utilization, 0.34);
  assert.equal(windows[1].resetsAt, new Date('2026-09-29T08:59:59.640129+00:00').toISOString());
});

test('모르는 kind 도 떨구지 않는다', async () => {
  const { service } = createService({
    usage: usageResponse({
      limits: [{ kind: 'monthly_something', percent: 5, severity: 'normal', resets_at: null }],
    }),
  });

  const { windows } = await service.getSnapshot();

  assert.equal(windows.length, 1);
  assert.equal(windows[0].type, 'monthly_something');
  assert.equal(windows[0].resetsAt, null);
});

test('severity 를 status 어휘로 옮기고, 모르는 값은 사용률로 판단한다', async () => {
  const { service } = createService({
    usage: usageResponse({
      limits: [
        { kind: 'a', percent: 85, severity: 'warning' },
        { kind: 'b', percent: 100, severity: 'blocked' },
        // 모르는 severity + 다 쓴 창은 정상으로 그리지 않는다.
        { kind: 'c', percent: 100, severity: 'unheard_of' },
        { kind: 'd', percent: 10, severity: 'unheard_of' },
      ],
    }),
  });

  const statuses = (await service.getSnapshot()).windows.map((window) => window.status);

  assert.deepEqual(statuses, ['allowed_warning', 'rejected', 'rejected', 'allowed']);
});

test('초과 사용은 켜 둔 계정에서만 창이 된다', async () => {
  const off = createService();
  const on = createService({
    usage: usageResponse({
      limits: [],
      extra_usage: { is_enabled: true, utilization: 40, spend_limit_reached: false },
    }),
  });

  assert.ok(!(await off.service.getSnapshot()).windows.some((w) => w.type === 'overage'));

  const { windows } = await on.service.getSnapshot();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].type, 'overage');
  assert.equal(windows[0].utilization, 0.4);
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

test('로그인하지 않았거나 조회에 실패하면 빈 창으로 답한다', async () => {
  const notLoggedIn = createService({ credentials: null });
  const failing = createService({ fail: true });

  // 부른 쪽이 쌓아 둔 이벤트로 물러설 수 있게, 실패와 미로그인을 구분하지 않는다.
  assert.deepEqual((await notLoggedIn.service.getSnapshot()).windows, []);
  assert.deepEqual((await failing.service.getSnapshot()).windows, []);
});

const cliWindow: ProviderRateLimitWindow = {
  type: 'five_hour',
  status: 'allowed',
  utilization: 0.08,
  resetsAt: null,
  observedAt: '2026-09-26T00:00:00.000Z',
};

test('직접 물어보기가 비면 CLI 로 물러서고, 성공하면 CLI 를 부르지 않는다', async () => {
  const failing = createService({ fail: true, cliWindows: [cliWindow] });
  const working = createService({ cliWindows: [cliWindow] });

  const fallback = await failing.service.getSnapshot();
  assert.equal(fallback.source, 'cli');
  assert.deepEqual(fallback.windows, [cliWindow]);

  const direct = await working.service.getSnapshot();
  assert.equal(direct.source, 'live');
  assert.equal(working.cliCount(), 0);
});

test('아무 길로도 못 읽으면 캐시하지 않고 다음 요청에서 다시 시도한다', async () => {
  const harness = createService({ fail: true });

  await harness.service.getSnapshot();
  await harness.service.getSnapshot();

  // 로그인을 막 끝낸 직후에도 다음 요청이 바로 값을 가져와야 한다.
  assert.equal(harness.fetchCount(), 2);
  assert.equal(harness.cliCount(), 2);
});
