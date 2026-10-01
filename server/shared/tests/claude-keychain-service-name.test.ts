import assert from 'node:assert/strict';
import test from 'node:test';

import { getClaudeKeychainServiceName } from '@/shared/utils.js';

const withConfigDir = (value: string | undefined, run: () => void) => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }
};

test('default config directory uses the bare keychain item', () => {
  withConfigDir(undefined, () => {
    assert.equal(getClaudeKeychainServiceName('/Users/someone'), 'Claude Code-credentials');
  });
});

test('custom config directory suffixes the item with its hash, as Claude Code does', () => {
  // 실제 설치에서 Claude Code 가 만든 항목 이름과 대조한 값이다.
  withConfigDir('/Users/linalee/.claude-work', () => {
    assert.equal(getClaudeKeychainServiceName('/Users/linalee'), 'Claude Code-credentials-26fbef30');
  });
});

test('a home-relative config directory hashes its resolved path', () => {
  withConfigDir('~/.claude-work', () => {
    assert.equal(getClaudeKeychainServiceName('/Users/linalee'), 'Claude Code-credentials-26fbef30');
  });
});
