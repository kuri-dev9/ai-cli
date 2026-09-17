import assert from 'node:assert/strict';

import { afterAll, describe, expect, it, test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { i18n } from '@/modules/i18n';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

const createDiff = createCachedDiffCalculator();
const PROMPT = '빌드 한 번 돌려줘';
const initialLanguage = i18n.language;

afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

function normalizedUserMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'user-1',
    sessionId: 'session-1',
    timestamp: '2026-09-17T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: PROMPT,
    ...overrides,
  };
}

function renderUserBubble(message: Partial<ChatMessage>): string {
  return renderToStaticMarkup(
    React.createElement(MessageComponent, {
      message: {
        type: 'user',
        content: PROMPT,
        timestamp: '2026-09-17T12:00:00.000Z',
        ...message,
      } as ChatMessage,
      prevMessage: null,
      createDiff,
      provider: 'claude',
    }),
  );
}

// 배지는 서버가 붙여 준 `source` 하나에만 달려 있다. 그 값이 화면까지
// 내려오지 않으면 배지는 영원히 나타나지 않으므로, 옮겨지는 것부터 본다.
test('정규화된 메시지의 출처가 UI 메시지로 그대로 옮겨진다', () => {
  const [converted] = normalizedToChatMessages([normalizedUserMessage({ source: 'telegram' })]);

  assert.equal(converted?.type, 'user');
  assert.equal(converted?.source, 'telegram');
  // 프롬프트 본문은 어디서도 변형되지 않는다.
  assert.equal(converted?.content, PROMPT);
});

test('출처가 없는 메시지는 출처 없이 옮겨진다', () => {
  const [converted] = normalizedToChatMessages([normalizedUserMessage()]);

  assert.equal(converted?.source, undefined);
});

describe('사용자 버블의 출처 배지', () => {
  it('텔레그램에서 온 메시지에 배지를 붙인다', () => {
    const markup = renderUserBubble({ source: 'telegram' });

    // lucide 의 종이비행기 아이콘. 배지가 글자만 있는 것이 아님을 확인한다.
    expect(markup).toContain('lucide-send');
    expect(markup).toContain(PROMPT);
  });

  it('브라우저에서 친 메시지에는 배지가 없다', () => {
    const markup = renderUserBubble({});

    expect(markup).not.toContain('lucide-send');
    // 배지가 없어도 버블 자체는 그대로다.
    expect(markup).toContain(PROMPT);
  });

  // 타입은 'telegram' 만 허용하지만, 값은 서버가 DB 에서 읽어 오는 것이라
  // 더 오래된/새로운 배포가 모르는 이름을 보낼 수 있다. 그때 배지를 그리지
  // 않는지 본다.
  it('모르는 출처에는 배지를 붙이지 않는다', () => {
    const markup = renderUserBubble({ source: 'carrier-pigeon' } as unknown as Partial<ChatMessage>);

    expect(markup).not.toContain('lucide-send');
  });

  // ko/en 양쪽에 키가 있어야 한다. 한쪽이 비면 i18next 가 키 이름을 그대로
  // 그려서 "message.source.telegram" 이 버블에 찍힌다.
  it.each([
    ['ko', '텔레그램'],
    ['en', 'Telegram'],
  ])('%s 로케일에서 라벨이 번역된다', async (language, label) => {
    await i18n.changeLanguage(language);
    const markup = renderUserBubble({ source: 'telegram' });

    expect(markup).toContain(label);
    expect(markup).not.toContain('message.source.telegram');
  });
});
