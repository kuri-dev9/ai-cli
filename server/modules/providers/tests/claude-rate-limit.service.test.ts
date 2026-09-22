import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeRateLimitService } from '@/modules/providers/services/claude-rate-limit.service.js';

/** Stands in for the app_config row the real service reads and writes. */
function createStore(initial: string | null = null) {
  let raw = initial;
  return {
    readRaw: () => raw,
    writeRaw: (value: string) => {
      raw = value;
    },
    peek: () => raw,
  };
}

function createServiceAt(timestamps: string[], initial: string | null = null) {
  const store = createStore(initial);
  let index = 0;
  const service = createClaudeRateLimitService({
    readRaw: store.readRaw,
    writeRaw: store.writeRaw,
    // Each call advances, so successive readings get distinct observedAt values.
    now: () => new Date(timestamps[Math.min(index++, timestamps.length - 1)]),
  });
  return { service, store };
}

test('each window type keeps its own newest reading', () => {
  const { service } = createServiceAt([
    '2026-09-22T01:00:00.000Z',
    '2026-09-22T02:00:00.000Z',
    '2026-09-22T03:00:00.000Z',
  ]);

  service.record({ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.07 });
  service.record({ rateLimitType: 'seven_day', status: 'allowed', utilization: 0.21 });
  // A second five_hour reading replaces the first rather than adding a window.
  service.record({ rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.83 });

  const { windows } = service.getSnapshot();
  assert.equal(windows.length, 2);

  const fiveHour = windows.find((window) => window.type === 'five_hour');
  assert.equal(fiveHour?.utilization, 0.83);
  assert.equal(fiveHour?.status, 'allowed_warning');

  const sevenDay = windows.find((window) => window.type === 'seven_day');
  assert.equal(sevenDay?.utilization, 0.21);

  // Most recently observed first, so the freshest window heads the list.
  assert.equal(windows[0].type, 'five_hour');
});

test('resetsAt is accepted in both seconds and milliseconds', () => {
  const { service } = createServiceAt(['2026-09-22T01:00:00.000Z', '2026-09-22T01:00:01.000Z']);
  const expected = '2026-09-22T08:59:00.000Z';
  const epochSeconds = Date.parse(expected) / 1000;

  service.record({ rateLimitType: 'five_hour', resetsAt: epochSeconds });
  service.record({ rateLimitType: 'seven_day', resetsAt: epochSeconds * 1000 });

  const { windows } = service.getSnapshot();
  assert.equal(windows.find((window) => window.type === 'five_hour')?.resetsAt, expected);
  assert.equal(windows.find((window) => window.type === 'seven_day')?.resetsAt, expected);
});

test('unrecognized window types survive so a newer CLI needs no server change', () => {
  const { service } = createServiceAt(['2026-09-22T01:00:00.000Z']);

  service.record({ rateLimitType: 'seven_day_fable', status: 'allowed', utilization: 0 });

  const { windows } = service.getSnapshot();
  assert.deepEqual(windows.map((window) => window.type), ['seven_day_fable']);
  assert.equal(windows[0].utilization, 0);
});

test('readings with no window type or no payload are ignored', () => {
  const { service, store } = createServiceAt(['2026-09-22T01:00:00.000Z']);

  service.record(null);
  service.record({ status: 'allowed', utilization: 0.5 });
  service.record({ rateLimitType: '   ' });

  assert.equal(store.peek(), null);
  assert.deepEqual(service.getSnapshot().windows, []);
});

test('missing utilization stays null instead of reading as zero usage', () => {
  const { service } = createServiceAt(['2026-09-22T01:00:00.000Z']);

  service.record({ rateLimitType: 'five_hour', status: 'allowed' });

  const [window] = service.getSnapshot().windows;
  assert.equal(window.utilization, null);
  assert.equal(window.resetsAt, null);
});

test('utilization past the limit clamps to a full bar', () => {
  const { service } = createServiceAt(['2026-09-22T01:00:00.000Z']);

  service.record({ rateLimitType: 'seven_day', status: 'rejected', utilization: 1.4 });

  assert.equal(service.getSnapshot().windows[0].utilization, 1);
});

test('a corrupt stored blob is discarded rather than failing the read', () => {
  const { service } = createServiceAt(['2026-09-22T01:00:00.000Z'], '{not json');

  assert.deepEqual(service.getSnapshot().windows, []);

  // The next event rebuilds the store from scratch.
  service.record({ rateLimitType: 'five_hour', utilization: 0.1 });
  assert.equal(service.getSnapshot().windows.length, 1);
});

test('persisted readings are restored across a restart', () => {
  const first = createServiceAt(['2026-09-22T01:00:00.000Z']);
  first.service.record({ rateLimitType: 'seven_day', status: 'allowed', utilization: 0.21 });

  // A fresh service over the same stored row — as the server would see on boot.
  const restarted = createClaudeRateLimitService({
    readRaw: first.store.readRaw,
    writeRaw: first.store.writeRaw,
  });

  const [window] = restarted.getSnapshot().windows;
  assert.equal(window.type, 'seven_day');
  assert.equal(window.utilization, 0.21);
  assert.equal(window.observedAt, '2026-09-22T01:00:00.000Z');
});
