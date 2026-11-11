import assert from 'node:assert/strict';
import test from 'node:test';

import { decideAutoCompact, isCompactCommand, parseAutoCompactSetting } from '@/shared/auto-compact.js';

test('턴 기준은 지난번에 줄인 뒤로 쌓인 턴 수가 닿으면 걸린다', () => {
  const policy = { everyTurns: 3, tokens: 0 };
  assert.equal(decideAutoCompact(policy, { turnsSinceCompact: 2 }), null);
  assert.equal(decideAutoCompact(policy, { turnsSinceCompact: 3 }), 'turns');
});

test('토큰 기준은 사용량이 기준 이상이면 걸리고, 0 이면 대신 비율을 본다', () => {
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 100_000 }, { turnsSinceCompact: 0, used: 99_999, total: 1_000_000 }), null);
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 100_000 }, { turnsSinceCompact: 0, used: 100_000, total: 1_000_000 }), 'tokens');
  // 토큰 기준을 정하면 비율은 보지 않는다.
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 500_000, fallbackRatio: 0.6 }, { turnsSinceCompact: 0, used: 150_000, total: 200_000 }), null);
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 0, fallbackRatio: 0.6 }, { turnsSinceCompact: 0, used: 120_000, total: 200_000 }), 'tokens');
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 0, fallbackRatio: 0.6 }, { turnsSinceCompact: 0, used: 118_000, total: 200_000 }), null);
});

test('둘 다 끄면 무엇도 걸리지 않고, 사용량을 모르면 토큰 기준은 걸리지 않는다', () => {
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 0 }, { turnsSinceCompact: 99, used: 999_999, total: 1_000_000 }), null);
  assert.equal(decideAutoCompact({ everyTurns: 0, tokens: 1 }, { turnsSinceCompact: 0 }), null);
});

test('설정값은 0 이상 상한 이하의 정수만 받는다', () => {
  assert.equal(parseAutoCompactSetting(0, 50), 0);
  assert.equal(parseAutoCompactSetting('12', 50), 12);
  assert.equal(parseAutoCompactSetting(51, 50), null);
  assert.equal(parseAutoCompactSetting(-1, 50), null);
  assert.equal(parseAutoCompactSetting(1.5, 50), null);
  assert.equal(parseAutoCompactSetting('abc', 50), null);
});

test('/compact 와 요약 지시가 붙은 /compact 만 줄이기 명령이다', () => {
  assert.equal(isCompactCommand('/compact'), true);
  assert.equal(isCompactCommand('  /compact 테스트 위주로 남겨 줘'), true);
  assert.equal(isCompactCommand('/compactor'), false);
  assert.equal(isCompactCommand('compact 해 줘'), false);
});

test('줄인 뒤 아직 턴이 돌지 않았으면 어떤 기준도 걸리지 않는다', () => {
  const policy = { everyTurns: 1, tokens: 100_000, fallbackRatio: 0.6 };
  assert.equal(
    decideAutoCompact(policy, { turnsSinceCompact: 5, awaitingTurnAfterCompact: true, used: 190_000, total: 200_000 }),
    null,
  );
  assert.equal(decideAutoCompact(policy, { turnsSinceCompact: 0, used: 190_000, total: 200_000 }), 'tokens');
});
