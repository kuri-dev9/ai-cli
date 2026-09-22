import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Imported for its side effect: the panel calls useTranslation, which warns and
// falls back to raw keys unless the shared i18next instance is initialized.
import '@/modules/i18n';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import type { PermissionPanelProps, Question } from '@/shared/types';

// A single-select question is a radio group: picking a second option replaces
// the first, and clicking the chosen one again does not clear it. That is
// correct, but the panel drew both kinds of question with the same square
// indicator, so a pick-one list looked like a checkbox that refused to untick.
// The shape is what tells them apart now, and these tests hold it in place.

function renderPanel(question: Question) {
  return renderToStaticMarkup(
    React.createElement(AskUserQuestionPanel, {
      request: {
        requestId: 'req-1',
        toolName: 'AskUserQuestion',
        input: { questions: [question] },
      },
      onDecision: () => {},
    } as unknown as PermissionPanelProps),
  );
}

const OPTIONS = [{ label: 'First' }, { label: 'Second' }];

test('a pick-one question draws round indicators', () => {
  const markup = renderPanel({ question: 'Which one?', options: OPTIONS } as Question);

  assert.match(markup, /rounded-full font-mono/);
  assert.doesNotMatch(markup, /rounded-\[4px\] font-mono/);
});

test('a tick-many question draws square indicators', () => {
  const markup = renderPanel({
    question: 'Which ones?',
    options: OPTIONS,
    multiSelect: true,
  } as Question);

  assert.match(markup, /rounded-\[4px\] font-mono/);
  assert.doesNotMatch(markup, /rounded-full font-mono/);
});

test('the "Other" row matches the shape of the options above it', () => {
  // Both the options and the Other row carry the indicator, so a mismatch here
  // would put a checkbox at the bottom of a radio list.
  const single = renderPanel({ question: 'Which one?', options: OPTIONS } as Question);
  const multi = renderPanel({
    question: 'Which ones?',
    options: OPTIONS,
    multiSelect: true,
  } as Question);

  // Two options plus the Other row.
  assert.equal(single.match(/rounded-full font-mono/g)?.length, 3);
  assert.equal(multi.match(/rounded-\[4px\] font-mono/g)?.length, 3);
});

test('each question states its selection mode in words as well', () => {
  assert.match(renderPanel({ question: 'Which one?', options: OPTIONS } as Question), /Pick one/);
  assert.match(
    renderPanel({ question: 'Which ones?', options: OPTIONS, multiSelect: true } as Question),
    /Select all that apply/,
  );
});
