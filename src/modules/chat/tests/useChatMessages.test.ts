import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';

function message(
  id: string,
  overrides: Partial<NormalizedMessage>,
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    timestamp: '2026-08-19T12:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'assistant',
    content: id,
    ...overrides,
  };
}

test('preserves historical UI message identity when only the stream record changes', () => {
  const first = message('first', { content: 'First answer' });
  const second = message('second', { content: 'Second answer' });
  const firstStream = message('stream', {
    kind: 'stream_delta',
    content: 'Part one',
  });

  const initial = normalizedToChatMessages([first, second, firstStream]);
  const nextStream = { ...firstStream, content: 'Part one and two' };
  const updated = normalizedToChatMessages([first, second, nextStream]);

  assert.notStrictEqual(updated, initial);
  assert.strictEqual(updated[0], initial[0]);
  assert.strictEqual(updated[1], initial[1]);
  assert.notStrictEqual(updated[2], initial[2]);
  assert.equal(updated[2]?.content, 'Part one and two');
});

test('rebuilds a tool-use UI message when its separately received result changes', () => {
  const toolUse = message('tool-use', {
    kind: 'tool_use',
    toolId: 'tool-1',
    toolName: 'Read',
    toolInput: { file_path: 'README.md' },
  });

  const withoutResult = normalizedToChatMessages([toolUse]);
  assert.equal(withoutResult[0]?.toolResult, null);

  const toolResult = message('tool-result', {
    kind: 'tool_result',
    toolId: 'tool-1',
    content: 'file contents',
  });
  const withResult = normalizedToChatMessages([toolUse, toolResult]);

  assert.equal(withResult.length, 1);
  assert.notStrictEqual(withResult[0], withoutResult[0]);
  assert.deepEqual(withResult[0]?.toolResult, {
    content: 'file contents',
    isError: false,
    toolUseResult: undefined,
  });

  const unrelatedStream = message('stream', {
    kind: 'stream_delta',
    content: 'Still working',
  });
  const afterUnrelatedUpdate = normalizedToChatMessages([
    toolUse,
    toolResult,
    unrelatedStream,
  ]);
  assert.strictEqual(afterUnrelatedUpdate[0], withResult[0]);

  const changedToolResult = {
    ...toolResult,
    content: 'updated file contents',
  };
  const afterResultChange = normalizedToChatMessages([
    toolUse,
    changedToolResult,
    unrelatedStream,
  ]);

  assert.notStrictEqual(afterResultChange[0], afterUnrelatedUpdate[0]);
  assert.strictEqual(afterResultChange[1], afterUnrelatedUpdate[1]);
  assert.equal(afterResultChange[0]?.toolResult?.content, 'updated file contents');
});

test('preserves existing UI objects when an older message is prepended', () => {
  const first = message('first', { content: 'First loaded message' });
  const second = message('second', { content: 'Second loaded message' });
  const initial = normalizedToChatMessages([first, second]);

  const older = message('older', {
    content: 'Older paginated message',
    timestamp: '2026-08-18T12:00:00.000Z',
  });
  const withOlderHistory = normalizedToChatMessages([older, first, second]);

  assert.strictEqual(withOlderHistory[1], initial[0]);
  assert.strictEqual(withOlderHistory[2], initial[1]);
});

test('preserves both UI objects produced by an unchanged task notification', () => {
  const notification = message('task-notification', {
    role: 'user',
    content: [
      '<task-notification>',
      '<status>completed</status>',
      '<summary>Background task finished</summary>',
      '<result>Detailed result</result>',
      '</task-notification>',
    ].join('\n'),
  });

  const initial = normalizedToChatMessages([notification]);
  assert.equal(initial.length, 2);

  const unrelated = message('unrelated', { content: 'A later message' });
  const updated = normalizedToChatMessages([notification, unrelated]);

  assert.strictEqual(updated[0], initial[0]);
  assert.strictEqual(updated[1], initial[1]);
  assert.equal(updated[0]?.isTaskNotification, true);
  assert.equal(updated[1]?.content, 'Detailed result');
});

test('an async agent launch shows running until its task-notification arrives', () => {
  const launch = message('agent-launch', {
    kind: 'tool_use',
    toolId: 'tool-async-1',
    toolName: 'Task',
    toolInput: { subagent_type: 'Explore', prompt: 'find the bug' },
  });
  // `toolUseResult` is a real field the backend attaches to a tool_result row
  // (see claude-sessions.provider.ts), left off `NormalizedMessage` on purpose
  // so most call sites cannot read it untyped; widen locally to construct one.
  // Shape matches the SDK's generated `AgentOutput` type (sdk-tools.d.ts):
  // an async launch is tagged `status: 'async_launched'`, not `isAsync`.
  const ackOverrides: Partial<NormalizedMessage> & { toolUseResult?: unknown } = {
    kind: 'tool_result',
    toolId: 'tool-async-1',
    content: 'Async agent launched successfully.',
    toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
  };
  const ack = message('agent-ack', ackOverrides);

  const whileRunning = normalizedToChatMessages([launch, ack]);
  assert.equal(whileRunning.length, 1);
  assert.equal(whileRunning[0]?.subagent?.status, 'running');
  // The launch ack is internal bookkeeping, not the agent's answer.
  assert.equal(whileRunning[0]?.toolResult?.content, '');

  const notification = message('agent-notification', {
    role: 'user',
    content: [
      '<task-notification>',
      '<tool-use-id>tool-async-1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Found it</summary>',
      '<result>The bug is in foo.ts</result>',
      '</task-notification>',
    ].join('\n'),
  });

  const afterCompletion = normalizedToChatMessages([launch, ack, notification]);
  const launchMessage = afterCompletion.find((msg) => msg.toolId === 'tool-async-1');
  assert.equal(launchMessage?.subagent?.status, 'completed');
  assert.notStrictEqual(launchMessage, whileRunning[0]);

  // A later, unrelated update must not invalidate the now-resolved projection.
  const unrelated = message('unrelated', { content: 'A later message' });
  const afterUnrelatedUpdate = normalizedToChatMessages([launch, ack, notification, unrelated]);
  assert.strictEqual(
    afterUnrelatedUpdate.find((msg) => msg.toolId === 'tool-async-1'),
    launchMessage,
  );
});
