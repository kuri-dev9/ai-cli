import assert from 'node:assert/strict';

import { test } from 'vitest';

import { resolveProjectActivity } from '@/modules/sidebar/utils/projectActivity';

/**
 * 접어 둔 프로젝트에서도 "여기를 봐야 한다"가 보여야 한다. 이 함수가 그 판단을
 * 혼자 맡고 있으므로, 우선순위와 경계를 여기서 고정한다.
 */

const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const none: ReadonlySet<string> = new Set();

test('조용한 프로젝트에는 점을 찍지 않는다', () => {
  assert.equal(resolveProjectActivity(sessions, none, none), null);
});

test('돌고 있는 세션이 있으면 processing 이다', () => {
  assert.equal(resolveProjectActivity(sessions, none, new Set(['b'])), 'processing');
});

test('확인이 필요한 세션이 있으면 attention 이다', () => {
  assert.equal(resolveProjectActivity(sessions, new Set(['c']), none), 'attention');
});

test('둘이 겹치면 급한 쪽인 attention 이 이긴다', () => {
  // 돌고 있는 것은 기다리면 되지만, 답을 기다리는 것은 사람이 가야 끝난다.
  const activity = resolveProjectActivity(sessions, new Set(['c']), new Set(['a']));
  assert.equal(activity, 'attention');
});

test('다른 프로젝트의 세션 상태에 반응하지 않는다', () => {
  // 집합은 사이드바 전체에서 공유된다. 내 세션만 보는지가 핵심이다.
  const activity = resolveProjectActivity(sessions, new Set(['z']), new Set(['y']));
  assert.equal(activity, null);
});

test('세션이 없는 프로젝트는 조용하다', () => {
  assert.equal(resolveProjectActivity([], new Set(['a']), new Set(['a'])), null);
});
