import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesToolPermission } from '@/modules/providers/list/claude/claude-runtime.provider.js';

test('an MCP server rule allows every tool of that server', () => {
  // Claude Code 규칙과 같은 뜻이다. 이것이 없어서 서버 단위로 허용해 둬도 매번 물었다.
  assert.equal(matchesToolPermission('mcp__query_forge', 'mcp__query_forge__query', {}), true);
  assert.equal(matchesToolPermission('mcp__query_forge__*', 'mcp__query_forge__schema', {}), true);
});

test('an MCP server rule does not reach other servers', () => {
  assert.equal(matchesToolPermission('mcp__query_forge', 'mcp__other__x', {}), false);
  assert.equal(matchesToolPermission('mcp__query_forge__*', 'mcp__other__x', {}), false);
  // 이름이 앞부분만 같은 서버도 열리면 안 된다.
  assert.equal(matchesToolPermission('mcp__query', 'mcp__query_forge__query', {}), false);
});

test('an MCP tool rule still matches only that tool', () => {
  assert.equal(matchesToolPermission('mcp__query_forge__query', 'mcp__query_forge__query', {}), true);
  assert.equal(matchesToolPermission('mcp__query_forge__query', 'mcp__query_forge__schema', {}), false);
});

test('existing Bash and exact-name rules keep working', () => {
  assert.equal(matchesToolPermission('Bash(git status:*)', 'Bash', { command: 'git status -s' }), true);
  assert.equal(matchesToolPermission('Bash(git status:*)', 'Bash', { command: 'git push' }), false);
  assert.equal(matchesToolPermission('Read', 'Read', {}), true);
  assert.equal(matchesToolPermission('Read', 'Write', {}), false);
});
