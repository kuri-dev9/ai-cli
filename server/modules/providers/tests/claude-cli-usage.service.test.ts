import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeCliUsageService } from '@/modules/providers/services/claude-cli-usage.service.js';

/** 실제 `claude -p "/usage" --output-format json` 에서 이 서비스가 보는 부분만. */
const usageText = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 8% used · resets Oct 1 at 12:49pm (Asia/Seoul)',
  'Current week (all models): 6% used · resets Oct 6 at 5:59pm (Asia/Seoul)',
  'Current week (Fable): 0% used · resets Oct 6 at 6pm (Asia/Seoul)',
  '',
  "What's contributing to your limits usage?",
  'Last 7d · 551 requests · 6 sessions',
  '  58% of your usage was at >150k context',
].join('\n');

const commandOutput = (result: string) => JSON.stringify({ subtype: 'success', result });

/** 2026-10-01T02:00:00Z = 서울 기준 10월 1일 오전 11시. */
const NOW = Date.parse('2026-10-01T02:00:00.000Z');

const createService = (stdout: string | null, now = NOW) =>
  createClaudeCliUsageService({
    runUsageCommand: async () => stdout,
    now: () => now,
  });

test('/usage 요약에서 창과 사용률을 읽는다', async () => {
  const { windows } = await createService(commandOutput(usageText)).getSnapshot();

  assert.deepEqual(
    windows.map((window) => window.type),
    ['five_hour', 'seven_day', 'seven_day_fable'],
  );
  // 출력은 0..100 이고 화면은 0..1 을 읽는다.
  assert.equal(windows[0].utilization, 0.08);
  assert.equal(windows[1].utilization, 0.06);
  assert.equal(windows[2].utilization, 0);
  assert.equal(windows[0].observedAt, new Date(NOW).toISOString());
});

test('초기화 시각을 출력에 적힌 시간대로 읽는다', async () => {
  const { windows } = await createService(commandOutput(usageText)).getSnapshot();

  // Oct 1 12:49pm (Asia/Seoul, UTC+9) = 03:49Z.
  assert.equal(windows[0].resetsAt, '2026-10-01T03:49:00.000Z');
  // 분이 빠진 `6pm` 도 정각으로 읽는다.
  assert.equal(windows[2].resetsAt, '2026-10-06T09:00:00.000Z');
});

test('연도 없는 날짜가 한참 지났으면 다음 해로 읽는다', async () => {
  const december = Date.parse('2026-12-31T15:00:00.000Z');
  const { windows } = await createService(
    commandOutput('Current session: 3% used · resets Jan 1 at 9am (Asia/Seoul)'),
    december,
  ).getSnapshot();

  assert.equal(windows[0].resetsAt, '2027-01-01T00:00:00.000Z');
});

test('사용률로 상태를 매긴다', async () => {
  const { windows } = await createService(commandOutput([
    'Current session: 100% used · resets Oct 1 at 12:49pm (Asia/Seoul)',
    'Current week (all models): 85% used',
    'Current week (Opus): 12% used',
  ].join('\n'))).getSnapshot();

  assert.deepEqual(
    windows.map((window) => window.status),
    ['rejected', 'allowed_warning', 'allowed'],
  );
  // resets 가 없는 줄도 창으로 남는다 — 막대는 초기화 시각 없이도 그려진다.
  assert.equal(windows[1].resetsAt, null);
  assert.equal(windows[2].type, 'seven_day_opus');
});

test('CLI 가 실패하거나 출력이 달라지면 빈 목록으로 답한다', async () => {
  assert.deepEqual((await createService(null).getSnapshot()).windows, []);
  assert.deepEqual(
    (await createService(commandOutput('Not logged in. Run /login.')).getSnapshot()).windows,
    [],
  );
});

test('JSON 이 아닌 평문 출력도 읽는다', async () => {
  const { windows } = await createService(usageText).getSnapshot();

  assert.equal(windows.length, 3);
});

test('명령이 던져도 빈 목록으로 답한다', async () => {
  const service = createClaudeCliUsageService({
    runUsageCommand: async () => {
      throw new Error('spawn failed');
    },
    now: () => NOW,
  });

  assert.deepEqual((await service.getSnapshot()).windows, []);
});
