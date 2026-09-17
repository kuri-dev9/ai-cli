import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildPastedFileName,
  shouldConvertPasteToFile,
} from '@/modules/chat/hooks/useChatComposerState';

/**
 * 로그를 통째로 붙여넣으면 입력창이 대화를 덮어버린다. 그래서 큰 붙여넣기는
 * 첨부로 돌리는데, 기준이 너무 낮으면 평범한 문단까지 파일이 되어버린다.
 */

test('짧은 글은 그대로 입력창에 남는다', () => {
  assert.equal(shouldConvertPasteToFile('한 줄짜리 질문입니다'), false);
  assert.equal(shouldConvertPasteToFile('두 줄\n정도는 괜찮다'), false);
});

test('평범한 문단 몇 개는 파일로 바뀌지 않는다', () => {
  const paragraphs = Array.from({ length: 5 }, () => '이 정도 길이의 문장이 이어집니다.').join('\n\n');

  assert.equal(shouldConvertPasteToFile(paragraphs), false);
});

test('아주 긴 글은 첨부로 돌린다', () => {
  assert.equal(shouldConvertPasteToFile('가'.repeat(2_000)), true);
});

test('길이가 짧아도 줄이 많으면 첨부로 돌린다', () => {
  const log = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');

  assert.equal(shouldConvertPasteToFile(log), true);
});

test('빈 붙여넣기는 아무것도 하지 않는다', () => {
  assert.equal(shouldConvertPasteToFile(''), false);
});

test('첨부 이름에 줄 수가 들어간다', () => {
  const log = Array.from({ length: 30 }, () => 'x').join('\n');

  assert.equal(buildPastedFileName(log), 'pasted-30-lines.txt');
});
