import assert from 'node:assert/strict';

import React from 'react';
import { test } from 'vitest';

import { orderedListIndent } from '@/modules/chat/utils/orderedListIndent';

/**
 * 번호 목록의 번호는 목록 바깥 여백에 그려지고, 메시지 상자는 넘친 내용을
 * 그리지 않는다. 여백이 자릿수를 따라가지 않으면 "100." 의 앞자리가 잘린다.
 */

const items = (count: number) => Array.from({ length: count }, (_, i) => <li key={i}>{i}</li>);

test('한 자리 번호 목록은 예전 여백 그대로다', () => {
  assert.equal(orderedListIndent(undefined, items(9)), '1.25rem');
});

test('두 자리, 세 자리로 늘면 여백도 자릿수만큼 넓어진다', () => {
  assert.equal(orderedListIndent(undefined, items(10)), 'calc(3ch + 0.25rem)');
  assert.equal(orderedListIndent(undefined, items(100)), 'calc(4ch + 0.25rem)');
});

test('시작 번호가 크면 항목이 적어도 그 번호에 맞춘다', () => {
  // "98. 99. 100." — 항목은 셋이지만 마지막 번호는 세 자리다.
  assert.equal(orderedListIndent(98, items(3)), 'calc(4ch + 0.25rem)');
});

test('항목 사이 줄바꿈 텍스트는 세지 않는다', () => {
  assert.equal(orderedListIndent(undefined, ['\n', ...items(9), '\n']), '1.25rem');
});
