import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';
import type { RefObject, SetStateAction } from 'react';

import { BOT_RELAY_COMMAND, useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import type { Project, SlashCommand } from '@/shared/types';

/**
 * `/bot` 은 입력창의 슬래시 명령 목록에 있어야 하고, 고르면 실행되는 대신
 * 입력창에 남아야 한다.
 *
 * 목록에 없으면 "되는지 안 되는지 알 수 없는 숨은 기능"이 되고, 실행돼 버리면
 * 접두어 뒤에 할 말을 이어 쓸 수가 없다. 접두어를 실제로 떼는 것은 서버다 —
 * 여기서는 화면이 접두어를 남겨 주는 것까지만 확인한다.
 */

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

vi.mock('@/shared/api', () => ({
  api: {
    commands: {
      list: async () => jsonResponse({
        builtIn: [{ name: '/cost', description: 'Show token usage', namespace: 'builtin' }],
        custom: [],
      }),
    },
    providers: {
      skills: async () => jsonResponse({ success: true, data: { skills: [] } }),
    },
  },
}));

const project = {
  name: 'demo',
  path: '/tmp/demo',
  fullPath: '/tmp/demo',
  projectId: 'demo',
} as unknown as Project;

function setUp() {
  const executed: SlashCommand[] = [];
  let input = '';
  const textareaRef = { current: null } as RefObject<HTMLTextAreaElement>;
  // 훅이 받는 자리가 `Dispatch<SetStateAction<string>>` 이라 갱신 함수도 올 수
  // 있다. 문자열만 받는 모형으로 두면 훅이 함수형 갱신으로 바꾸는 순간 테스트가
  // 조용히 빈 입력을 보게 된다.
  const setInput = vi.fn((value: SetStateAction<string>) => {
    input = typeof value === 'function' ? value(input) : value;
  });

  const rendered = renderHook(() =>
    useSlashCommands({
      selectedProject: project,
      provider: 'claude',
      input,
      setInput,
      textareaRef,
      onExecuteCommand: (command: SlashCommand) => {
        executed.push(command);
      },
    }),
  );

  return { ...rendered, executed, setInput };
}

test('/bot 이 슬래시 명령 목록에 들어간다', async () => {
  const { result } = setUp();

  await waitFor(() => {
    assert.ok(result.current.slashCommands.length > 0);
  });

  const names = result.current.slashCommands.map((command) => command.name);
  assert.ok(names.includes('/bot'), `목록에 /bot 이 없다: ${names.join(', ')}`);
  // 서버가 주는 명령들과 나란히 보인다.
  assert.ok(names.includes('/cost'));
});

test('/bot 은 고르면 실행되지 않고 입력창에 남는다', async () => {
  const { result, executed, setInput } = setUp();

  await waitFor(() => {
    assert.ok(result.current.slashCommands.length > 0);
  });

  act(() => {
    result.current.handleCommandSelect(BOT_RELAY_COMMAND, 0, false);
  });

  // 서버의 명령 실행 경로로 가지 않는다 — `/bot` 은 실행할 명령이 아니라
  // 프롬프트 앞에 붙이는 표시다.
  assert.deepEqual(executed, []);
  assert.equal(setInput.mock.calls.length, 1);
  assert.equal(setInput.mock.calls[0][0], '/bot ');
});

test('명령 목록을 못 읽어도 /bot 과 /unbot 은 남는다', async () => {
  const api = await import('@/shared/api');
  vi.spyOn(api.api.commands, 'list').mockRejectedValueOnce(new Error('offline'));

  const { result } = setUp();

  await waitFor(() => {
    // 둘 다 서버 목록과 무관하게 동작한다. 여기서 빠지면 대화를 폰으로 넘기거나
    // 되돌리는 방법이 화면에서 사라진다.
    assert.deepEqual(
      result.current.slashCommands.map((command) => command.name),
      ['/bot', '/unbot'],
    );
  });
});
