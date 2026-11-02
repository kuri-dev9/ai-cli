import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeAccountService } from '@/modules/providers/services/claude-account.service.js';

/** Stands in for the app_config row and the `CLAUDE_CONFIG_DIR` env var. */
function createHarness(initialConfigDirEnv: string | undefined = undefined) {
  let accountsRaw: string | null = null;
  const configDirEnv = initialConfigDirEnv;
  let nextId = 0;

  const service = createClaudeAccountService({
    readAccountsRaw: () => accountsRaw,
    writeAccountsRaw: (value) => {
      accountsRaw = value;
    },
    readConfigDirEnv: () => configDirEnv,
    generateId: () => `id-${nextId++}`,
  });

  return { service };
}

test('listAccounts seeds one account from whatever CLAUDE_CONFIG_DIR is already set', () => {
  const { service } = createHarness('/Users/linalee/.claude-work');

  const accounts = service.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].configDir, '/Users/linalee/.claude-work');
  assert.equal(accounts[0].label, '.claude-work');
});

test('listAccounts seeds a default-labeled account when no env var is set', () => {
  const { service } = createHarness(undefined);

  const accounts = service.listAccounts();
  assert.equal(accounts[0].configDir, null);
  assert.equal(accounts[0].label, '기본 계정');
});

test('seeding is idempotent — a second read does not create a second account', () => {
  const { service } = createHarness('/Users/linalee/.claude-work');

  service.listAccounts();
  const accounts = service.listAccounts();
  assert.equal(accounts.length, 1);
});

test('addAccount appends to the existing list', () => {
  const { service } = createHarness('/Users/linalee/.claude-work');
  service.listAccounts();

  const added = service.addAccount({ label: '기본', configDir: null });

  const accounts = service.listAccounts();
  assert.equal(accounts.length, 2);
  assert.equal(added.configDir, null);
});

test('addAccount rejects an empty label', () => {
  const { service } = createHarness();
  service.listAccounts();

  assert.throws(() => service.addAccount({ label: '   ', configDir: null }));
});

test('updateAccount changes only the given fields', () => {
  const { service } = createHarness();
  service.listAccounts();
  const added = service.addAccount({ label: 'work', configDir: '/Users/linalee/.calude' });

  const relabeled = service.updateAccount(added.id, { label: 'claude-work' });
  assert.equal(relabeled.label, 'claude-work');
  assert.equal(relabeled.configDir, '/Users/linalee/.calude');

  const repathed = service.updateAccount(added.id, { configDir: '/Users/linalee/.claude-work' });
  assert.equal(repathed.label, 'claude-work');
  assert.equal(repathed.configDir, '/Users/linalee/.claude-work');
});

test('updateAccount with an empty configDir resets it to the default', () => {
  const { service } = createHarness();
  service.listAccounts();
  const added = service.addAccount({ label: 'work', configDir: '/Users/linalee/.claude-work' });

  const updated = service.updateAccount(added.id, { configDir: '' });

  assert.equal(updated.configDir, null);
});

test('updateAccount rejects clearing the label to empty', () => {
  const { service } = createHarness();
  service.listAccounts();
  const added = service.addAccount({ label: 'work', configDir: null });

  assert.throws(() => service.updateAccount(added.id, { label: '   ' }));
});

test('updateAccount on an unknown id throws', () => {
  const { service } = createHarness();
  service.listAccounts();

  assert.throws(() => service.updateAccount('missing', { label: 'x' }));
});

test('removeAccount drops an account by id', () => {
  const { service } = createHarness();
  service.listAccounts();
  const added = service.addAccount({ label: 'work', configDir: '/Users/linalee/.claude-work' });

  service.removeAccount(added.id);

  assert.equal(service.listAccounts().length, 1);
});

test('removeAccount on an unknown id throws instead of silently no-op-ing', () => {
  const { service } = createHarness();
  service.listAccounts();

  assert.throws(() => service.removeAccount('missing'));
});

test('removing every account re-seeds from the server default on the next read', () => {
  const { service } = createHarness('/Users/linalee/.claude-work');
  const [seeded] = service.listAccounts();

  service.removeAccount(seeded.id);

  const accounts = service.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].configDir, '/Users/linalee/.claude-work');
});

test('resolveAccount finds a registered account by id', () => {
  const { service } = createHarness();
  service.listAccounts();
  const added = service.addAccount({ label: 'work', configDir: '/Users/linalee/.claude-work' });

  const resolved = service.resolveAccount(added.id);

  assert.equal(resolved?.configDir, '/Users/linalee/.claude-work');
});

test('resolveAccount returns undefined for a missing or empty id', () => {
  const { service } = createHarness();
  service.listAccounts();

  assert.equal(service.resolveAccount('missing'), undefined);
  assert.equal(service.resolveAccount(null), undefined);
  assert.equal(service.resolveAccount(undefined), undefined);
});
