import assert from 'node:assert/strict';

import { test } from 'vitest';

import { BOT_RELAY_COMMAND, isPromptPrefixCommand } from '@/modules/chat/hooks/useSlashCommands';
import type { SlashCommand } from '@/shared/types';

/**
 * 입력창의 `/...` 를 전송할 때, 그것을 "실행"할지 "프롬프트로 보낼지" 가리는
 * 판정이다.
 *
 * 전송 경로가 한때 `type !== 'skill'` 로만 걸러서, `/bot` 이 커스텀 명령 실행
 * API 로 넘어가 "Command path is required for custom commands" 로 끝났다. 실행할
 * 파일이 없는 명령을 실행하려 했으니 나올 수밖에 없는 오류였다.
 */

const command = (overrides: Partial<SlashCommand>): SlashCommand => ({
  name: '/x',
  description: '',
  namespace: 'builtin',
  ...overrides,
} as SlashCommand);

test('`/bot` 은 실행하지 않고 프롬프트로 보낸다', () => {
  assert.equal(isPromptPrefixCommand(BOT_RELAY_COMMAND), true);
});

test('스킬도 실행하지 않고 프롬프트로 보낸다', () => {
  assert.equal(isPromptPrefixCommand(command({ type: 'skill' })), true);
});

test('type 이 아니라 metadata 로만 스킬인 것도 같이 본다', () => {
  // 메뉴에서 고르는 경로는 원래 이쪽까지 봤다. 전송 경로만 좁게 보던 것이
  // `/bot` 오류의 뿌리였으므로, 두 경로가 같은 집합을 봐야 한다.
  assert.equal(isPromptPrefixCommand(command({ metadata: { type: 'skill' } })), true);
});

test('보통 명령은 그대로 실행된다', () => {
  // 이 판정이 넓어지면 실행돼야 할 명령까지 프롬프트로 새어 나간다.
  assert.equal(isPromptPrefixCommand(command({ metadata: { type: 'builtin' } })), false);
  assert.equal(isPromptPrefixCommand(command({ type: 'custom' })), false);
});
