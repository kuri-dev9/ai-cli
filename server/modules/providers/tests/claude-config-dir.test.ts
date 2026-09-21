import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scanStateDb, sessionsDb } from '@/modules/database/index.js';
import {
  getClaudeConfigFilePath,
  getClaudeHomeDirectory,
  isPathInsideDirectory,
} from '@/shared/utils.js';

// The provider registry is imported for its side effects during session
// synchronization, so the fixture home has to be in place before that import.
delete process.env.CLAUDE_CONFIG_DIR;
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'claude-config-dir-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { sessionSynchronizerService } = await import(
  '@/modules/providers/services/session-synchronizer.service.js'
);

process.on('exit', () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

const FAKE_HOME = path.join(path.sep, 'fake-home');

async function withConfigDirectory(
  configDirectory: string | null,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  if (configDirectory === null) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = configDirectory;
  }

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }
}

async function withIsolatedDatabase(run: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-config-dir-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await run(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one transcript the way Claude Code does: under
 * `<root>/projects/<encoded-cwd>/<session-id>.jsonl`, with `sessionId` and
 * `cwd` on the first row.
 */
async function writeTranscript(
  claudeHome: string,
  projectPath: string,
  sessionId: string,
): Promise<string> {
  const encodedProjectPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
  const projectDirectory = path.join(claudeHome, 'projects', encodedProjectPath);
  await mkdir(projectDirectory, { recursive: true });

  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'user', sessionId, cwd: projectPath })}\n`,
    'utf8',
  );
  return transcriptPath;
}

test('getClaudeHomeDirectory falls back to <home>/.claude when the variable is unset', async () => {
  await withConfigDirectory(null, async () => {
    assert.equal(getClaudeHomeDirectory(FAKE_HOME), path.join(FAKE_HOME, '.claude'));
    assert.equal(getClaudeConfigFilePath(FAKE_HOME), path.join(FAKE_HOME, '.claude.json'));
  });
});

test('getClaudeHomeDirectory honors CLAUDE_CONFIG_DIR', async () => {
  const configured = path.join(path.sep, 'somewhere', 'claude-work');

  await withConfigDirectory(configured, async () => {
    assert.equal(getClaudeHomeDirectory(FAKE_HOME), configured);
    // `.claude.json` sits beside `.claude` by default but moves *inside* the
    // configured directory, which is why it needs its own resolver.
    assert.equal(getClaudeConfigFilePath(FAKE_HOME), path.join(configured, '.claude.json'));
  });
});

test('getClaudeHomeDirectory expands a leading tilde and trims whitespace', async () => {
  await withConfigDirectory('  ~/claude-work  ', async () => {
    assert.equal(getClaudeHomeDirectory(FAKE_HOME), path.join(FAKE_HOME, 'claude-work'));
  });
});

test('getClaudeHomeDirectory reads the environment on every call', async () => {
  await withConfigDirectory(null, async () => {
    assert.equal(getClaudeHomeDirectory(FAKE_HOME), path.join(FAKE_HOME, '.claude'));
  });
  await withConfigDirectory(path.join(path.sep, 'moved'), async () => {
    assert.equal(getClaudeHomeDirectory(FAKE_HOME), path.join(path.sep, 'moved'));
  });
});

test('isPathInsideDirectory accepts contained paths and rejects escapes', () => {
  const root = path.join(path.sep, 'root');

  assert.equal(isPathInsideDirectory(path.join(root, 'a', 'b.jsonl'), root), true);
  assert.equal(isPathInsideDirectory(path.join(root, '..hidden'), root), true);
  assert.equal(isPathInsideDirectory(root, root), false);
  assert.equal(isPathInsideDirectory(path.join(path.sep, 'other', 'b.jsonl'), root), false);
  assert.equal(isPathInsideDirectory(path.join(root, '..', 'sibling'), root), false);
});

test('synchronizeSessions indexes transcripts from the configured config directory', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const configuredHome = path.join(workspace, 'claude-work');
    const projectPath = path.join(workspace, 'project');
    const transcriptPath = await writeTranscript(configuredHome, projectPath, 'configured-session');

    // Also present in the default root, to prove it is ignored rather than merged.
    await writeTranscript(path.join(fixtureHome, '.claude'), projectPath, 'legacy-session');

    await withConfigDirectory(configuredHome, async () => {
      const result = await sessionSynchronizerService.synchronizeSessions();

      assert.deepEqual(result.failures, []);
      const indexed = sessionsDb.getSessionById('configured-session');
      assert.ok(indexed, 'a transcript in the configured root must be indexed');
      assert.equal(indexed?.jsonl_path, transcriptPath);
      assert.equal(
        sessionsDb.getSessionById('legacy-session'),
        null,
        'a transcript outside the configured root must not be indexed',
      );
    });
  });
});

test('synchronizeSessions drops indexed sessions left behind by a previous config directory', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const configuredHome = path.join(workspace, 'claude-work');
    const projectPath = path.join(workspace, 'project');
    await writeTranscript(configuredHome, projectPath, 'configured-session');

    // A row from the previous root whose file still exists on disk: the file
    // check alone would keep it, but the CLI can no longer resume it.
    const legacyPath = await writeTranscript(
      path.join(fixtureHome, '.claude'),
      projectPath,
      'stale-session',
    );
    sessionsDb.createSession(
      'stale-session',
      'claude',
      projectPath,
      'Stale',
      undefined,
      undefined,
      legacyPath,
    );
    // Other providers keep their own roots and must be left alone.
    const codexPath = path.join(workspace, 'codex-session.jsonl');
    await writeFile(codexPath, '{}\n', 'utf8');
    sessionsDb.createSession(
      'codex-session',
      'codex',
      projectPath,
      'Codex',
      undefined,
      undefined,
      codexPath,
    );

    await withConfigDirectory(configuredHome, async () => {
      const result = await sessionSynchronizerService.synchronizeSessions();

      assert.deepEqual(result.failures, []);
      assert.equal(sessionsDb.getSessionById('stale-session'), null);
      assert.ok(sessionsDb.getSessionById('codex-session'), 'non-Claude rows must survive');
      assert.ok(sessionsDb.getSessionById('configured-session'));
    });
  });
});

test('a changed config directory forces a full rescan past the stored cursor', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const firstHome = path.join(workspace, 'claude-first');
    const secondHome = path.join(workspace, 'claude-second');
    const projectPath = path.join(workspace, 'project');

    await writeTranscript(firstHome, projectPath, 'first-session');
    await writeTranscript(secondHome, projectPath, 'second-session');

    await withConfigDirectory(firstHome, async () => {
      await sessionSynchronizerService.synchronizeSessions();
    });
    assert.ok(sessionsDb.getSessionById('first-session'));

    // An incremental scan only looks at files created after the cursor, so a
    // cursor ahead of every transcript makes one index nothing at all. Only
    // ignoring the cursor can surface the second root's existing transcript.
    scanStateDb.updateLastScannedAt(new Date(Date.now() + 60_000));

    await withConfigDirectory(secondHome, async () => {
      const result = await sessionSynchronizerService.synchronizeSessions();

      assert.deepEqual(result.failures, []);
      assert.ok(
        sessionsDb.getSessionById('second-session'),
        'a pre-existing transcript in the new root must be indexed',
      );
      assert.equal(sessionsDb.getSessionById('first-session'), null);
    });
  });
});
