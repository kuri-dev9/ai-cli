import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ChatMessage } from '@/shared/types';
import { deriveBackgroundAgentActivity } from '@/modules/chat/hooks/useBackgroundAgentActivity';

function agentCard(id: string, status: 'running' | 'completed' | 'failed', timestamp: string): ChatMessage {
  return {
    type: 'assistant',
    content: '',
    timestamp,
    isToolUse: true,
    toolName: 'Agent',
    toolId: id,
    isSubagentContainer: true,
    subagent: { id, status },
  };
}

const describe = (count: number) => `${count} running`;

test('reports agents still running after their turn, timed from the oldest launch', () => {
  const activity = deriveBackgroundAgentActivity([
    { type: 'user', content: 'go', timestamp: '2026-09-29T06:00:00.000Z' },
    agentCard('a', 'completed', '2026-09-29T06:00:01.000Z'),
    agentCard('b', 'running', '2026-09-29T06:00:05.000Z'),
    agentCard('c', 'running', '2026-09-29T06:00:02.000Z'),
  ], describe);

  assert.deepEqual(activity, {
    statusText: '2 running',
    canInterrupt: false,
    startedAt: Date.parse('2026-09-29T06:00:02.000Z'),
  });
});

test('stays hidden once every agent has reported back', () => {
  assert.equal(deriveBackgroundAgentActivity([
    agentCard('a', 'completed', '2026-09-29T06:00:01.000Z'),
    agentCard('b', 'failed', '2026-09-29T06:00:02.000Z'),
  ], describe), null);
});
