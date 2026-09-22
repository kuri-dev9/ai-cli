import assert from 'node:assert/strict';

import { test } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { foldQuestionAnswers } from '@/modules/chat/utils/questionAnswers';
import type { NormalizedMessage } from '@/shared/types';

// Regression coverage for the question card that stayed unanswered for a whole
// run: the backend only folds the chosen answers into an AskUserQuestion input
// on a history load, so a live turn rendered every option unticked until the
// session was reopened.

const QUESTIONS = [
  {
    question: '어느 범위로 구현할까요?',
    header: '구현 범위',
    multiSelect: false,
    options: [{ label: '세션+주간 바 먼저' }, { label: '상단 비용 블록만' }],
  },
  {
    question: '화면을 어디에 붙일까요?',
    header: '표시 위치',
    multiSelect: false,
    options: [{ label: '설정에 Usage 탭 추가' }, { label: '컴포저의 기존 토큰 바 옆' }],
  },
];

/** The prose result a live turn carries, verbatim from a real transcript. */
const ACKNOWLEDGEMENT =
  'Your questions have been answered: "어느 범위로 구현할까요?"="세션+주간 바 먼저", '
  + '"화면을 어디에 붙일까요?"="설정에 Usage 탭 추가". You can now continue with these answers in mind.';

function liveRows(): NormalizedMessage[] {
  return [
    {
      kind: 'tool_use',
      toolId: 'toolu_01',
      toolName: 'AskUserQuestion',
      toolInput: { questions: QUESTIONS },
      timestamp: '2026-09-22T01:00:00.000Z',
    },
    {
      kind: 'tool_result',
      toolId: 'toolu_01',
      content: ACKNOWLEDGEMENT,
      timestamp: '2026-09-22T01:00:01.000Z',
    },
  ] as unknown as NormalizedMessage[];
}

test('a live turn folds the picked answers into the question card', () => {
  const [card] = normalizedToChatMessages(liveRows());

  assert.equal(card.toolName, 'AskUserQuestion');
  const input = JSON.parse(card.toolInput as string);
  assert.deepEqual(input.answers, {
    '어느 범위로 구현할까요?': '세션+주간 바 먼저',
    '화면을 어디에 붙일까요?': '설정에 Usage 탭 추가',
  });
  // The questions must survive the fold — the card renders both halves.
  assert.equal(input.questions.length, 2);
});

test('the question card stays unanswered until its result arrives', () => {
  const [card] = normalizedToChatMessages(liveRows().slice(0, 1));

  assert.equal(JSON.parse(card.toolInput as string).answers, undefined);
});

test('the structured result wins over the acknowledgement sentence', () => {
  const folded = foldQuestionAnswers(
    { questions: QUESTIONS },
    {
      content: ACKNOWLEDGEMENT,
      toolUseResult: { answers: { '어느 범위로 구현할까요?': '상단 비용 블록만' } },
    },
  ) as { answers: Record<string, string> };

  assert.equal(folded.answers['어느 범위로 구현할까요?'], '상단 비용 블록만');
});

test('answers the backend already folded in are left alone', () => {
  const alreadyFolded = { questions: QUESTIONS, answers: { '어느 범위로 구현할까요?': '이미 저장된 답' } };
  const folded = foldQuestionAnswers(alreadyFolded, { content: ACKNOWLEDGEMENT });

  assert.equal(folded, alreadyFolded);
});

test('a multi-select answer arrives as a comma-joined label list', () => {
  const folded = foldQuestionAnswers(
    { questions: QUESTIONS },
    { toolUseResult: { answers: { '어느 범위로 구현할까요?': ['세션+주간 바 먼저', '상단 비용 블록만'] } } },
  ) as { answers: Record<string, string> };

  assert.equal(folded.answers['어느 범위로 구현할까요?'], '세션+주간 바 먼저, 상단 비용 블록만');
});

test('a skipped question leaves the input untouched', () => {
  const input = { questions: QUESTIONS };
  const folded = foldQuestionAnswers(input, {
    content: 'Your questions have been answered.',
  });

  assert.equal(folded, input);
});

test('a result that says nothing about answers leaves the input untouched', () => {
  const input = { questions: QUESTIONS };
  assert.equal(foldQuestionAnswers(input, { content: 'ok' }), input);
  assert.equal(foldQuestionAnswers(input, null), input);
});

test('a malformed input is returned as-is rather than throwing', () => {
  const nonArrayQuestions = { questions: 'nope' };

  assert.doesNotThrow(() => {
    assert.equal(foldQuestionAnswers('not json', { content: ACKNOWLEDGEMENT }), 'not json');
    assert.equal(
      foldQuestionAnswers(nonArrayQuestions, { content: ACKNOWLEDGEMENT }),
      nonArrayQuestions,
    );
  });
});
