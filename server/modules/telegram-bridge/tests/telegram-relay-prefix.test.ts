import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTelegramRelayPrefix, TELEGRAM_RELAY_PREFIX } from '@/modules/websocket/index.js';

/**
 * `/bot` 접두어 판정.
 *
 * 판정은 서버에서만 한다 — 화면에서 접두어를 떼는 것으로 충분해 보이지만,
 * 그러면 다른 클라이언트나 손으로 만든 websocket 프레임에서 온 `/bot` 이
 * 그대로 모델에게 흘러간다. 여기가 마지막 방어선이다.
 */

test('접두어는 떼고, 뗐다는 사실을 알려준다', () => {
  assert.deepEqual(parseTelegramRelayPrefix('/bot 테스트 돌려줘'), {
    content: '테스트 돌려줘',
    relayRequested: true,
  });
});

test('접두어 뒤의 본문은 손대지 않는다', () => {
  const parsed = parseTelegramRelayPrefix('/bot  줄바꿈\n두 번째 줄  ');

  assert.equal(parsed.relayRequested, true);
  // 앞의 여백만 사라지고 나머지는 사용자가 친 그대로다.
  assert.equal(parsed.content, '줄바꿈\n두 번째 줄  ');
});

test('대소문자는 가리지 않는다', () => {
  assert.equal(parseTelegramRelayPrefix('/BOT 확인').relayRequested, true);
});

test('접두어가 없으면 입력을 그대로 둔다', () => {
  assert.deepEqual(parseTelegramRelayPrefix('/botanical 정원 만들어줘'), {
    content: '/botanical 정원 만들어줘',
    relayRequested: false,
  });
  assert.deepEqual(parseTelegramRelayPrefix('로봇 이야기'), {
    content: '로봇 이야기',
    relayRequested: false,
  });
});

test('뒤에 아무 말도 없는 /bot 하나는 접두어로 보지 않는다', () => {
  // 이걸 접두어로 보면 빈 프롬프트로 한 턴이 시작된다. 명령을 고르던 중이거나
  // 오타였을 가능성이 훨씬 높다.
  assert.deepEqual(parseTelegramRelayPrefix(TELEGRAM_RELAY_PREFIX), {
    content: TELEGRAM_RELAY_PREFIX,
    relayRequested: false,
  });
  assert.deepEqual(parseTelegramRelayPrefix('/bot   '), {
    content: '/bot   ',
    relayRequested: false,
  });
});
