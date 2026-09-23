import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

const createDiff = createCachedDiffCalculator();
const IMAGE = { path: '/home/u/.codex/generated_images/thread-1/exec-1.png', name: 'exec-1.png', mimeType: 'image/png' };

// 코덱스가 그린 그림은 글 없이 images 만 실린 assistant 행으로 온다.
// 본문이 비었다고 버려지면 그림도 같이 사라지므로, 옮겨지는 것부터 본다.
test('그림만 실린 assistant 행이 이미지와 함께 UI 메시지로 옮겨진다', () => {
  const row: NormalizedMessage = {
    id: 'img-1',
    sessionId: 'session-1',
    timestamp: '2026-09-23T02:00:00.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: '',
    images: [IMAGE],
  };

  const [converted] = normalizedToChatMessages([row]);

  assert.equal(converted?.type, 'assistant');
  assert.equal(converted?.content, '');
  assert.deepEqual(converted?.images, [IMAGE]);
});

test('assistant 행의 그림은 왼쪽 정렬 카드로 그려진다', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MessageComponent, {
      message: {
        type: 'assistant',
        content: '',
        timestamp: '2026-09-23T02:00:00.000Z',
        images: [IMAGE],
      } as ChatMessage,
      prevMessage: null,
      createDiff,
      provider: 'codex',
    }),
  );

  // 정적 렌더에서는 fetch 가 돌지 않아 자리표시자만 나오지만, 카드 컨테이너와
  // 정렬은 이미 정해져 있어야 한다.
  assert.ok(markup.includes('justify-start'), 'assistant pictures sit on the left');
  assert.ok(!markup.includes('justify-end'), 'and never on the user side');
  assert.ok(markup.includes('animate-pulse'), 'a card placeholder is drawn per image');
});
