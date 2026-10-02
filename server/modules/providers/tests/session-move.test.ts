import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { ClaudeForkProvider } from '@/modules/providers/list/claude/claude-fork.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { CodexForkProvider } from '@/modules/providers/list/codex/codex-fork.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { IProviderFork } from '@/shared/interfaces.js';
import { encodeClaudeProjectDirName } from '@/shared/utils.js';

/**
 * Moving a conversation to another project.
 *
 * The provider side ties a conversation to its working directory, so a move is
 * a fork into the target directory with the session pointed at the copy. These
 * tests hold the three things that make that a move rather than a copy: the
 * session keeps its id, the copy records the new directory where the indexer
 * reads it, and the original is retired rather than offered back.
 */

const SESSION_ID = 'move-me';

type ForkInput = Parameters<IProviderFork['forkSession']>[0];

type Harness = {
  root: string;
  sourceProject: string;
  targetProject: string;
  targetProjectId: string;
  forkCalls: ForkInput[];
};

async function withMovableClaude(
  runTest: (harness: Harness) => Promise<void>,
  options: { disableFork?: boolean } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-move-'));
  const sourceProject = path.join(root, 'source');
  const targetProject = path.join(root, 'target');
  const forkedPath = path.join(root, 'native-moved.jsonl');
  await writeFile(path.join(root, 'native-source.jsonl'), '{}\n', 'utf8');
  await writeFile(forkedPath, '{}\n', 'utf8');

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  const forkCalls: ForkInput[] = [];
  const claude = providerRegistry.resolveProvider('claude') as { fork?: IProviderFork };
  const realFork = claude.fork;
  const replacement = options.disableFork
    ? undefined
    : {
      forkSession: async (input: ForkInput) => {
        forkCalls.push(input);
        return { providerSessionId: 'native-moved', jsonlPath: forkedPath };
      },
    } as IProviderFork;
  Object.defineProperty(claude, 'fork', { value: replacement, configurable: true, writable: true });

  try {
    projectsDb.createProjectPath(sourceProject, 'Source');
    const { project } = projectsDb.createProjectPath(targetProject, 'Target');
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', sourceProject, 'Moving session', now, now, path.join(root, 'native-source.jsonl'));
    sessionsDb.assignProviderSessionId(SESSION_ID, 'native-source');

    await runTest({ root, sourceProject, targetProject, targetProjectId: project?.project_id ?? '', forkCalls });
  } finally {
    Object.defineProperty(claude, 'fork', { value: realFork, configurable: true, writable: true });
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function assertAppError(promise: Promise<unknown>, statusCode: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: { statusCode?: number; code?: string }) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

// ── The service ───────────────────────────────────────────

test('a moved session keeps its id and now lives in the target project', async () => {
  await withMovableClaude(async ({ root, sourceProject, targetProject, targetProjectId, forkCalls }) => {
    const result = await sessionsService.moveSessionToProject(SESSION_ID, targetProjectId);

    assert.deepEqual(result, { sessionId: SESSION_ID, projectId: targetProjectId, projectPath: targetProject });
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0].projectPath, sourceProject);
    assert.equal(forkCalls[0].targetProjectPath, targetProject);
    // The whole conversation goes, not a prefix of it.
    assert.equal(forkCalls[0].upToAnchorId, undefined);

    const moved = sessionsDb.getSessionById(SESSION_ID);
    assert.equal(moved?.project_path, targetProject);
    assert.equal(moved?.provider_session_id, 'native-moved');
    assert.equal(moved?.jsonl_path, path.join(root, 'native-moved.jsonl'));
    assert.equal(moved?.custom_name, 'Moving session');
    assert.equal(sessionsDb.getAllSessions().length, 1);

    // The original stays on disk but is nobody's conversation any more.
    assert.equal(sessionsDb.isProviderSessionSuperseded('native-source', 'claude'), true);
    assert.deepEqual(sessionsDb.getSupersededTranscriptPaths(SESSION_ID), [path.join(root, 'native-source.jsonl')]);
  });
});

test('moving to the project it is already in is refused', async () => {
  await withMovableClaude(async ({ sourceProject, forkCalls }) => {
    const sourceProjectId = projectsDb.getProjectPath(sourceProject)?.project_id ?? '';
    await assertAppError(sessionsService.moveSessionToProject(SESSION_ID, sourceProjectId), 400, 'MOVE_SAME_PROJECT');
    assert.equal(forkCalls.length, 0);
  });
});

test('an unknown or archived target project is a 404', async () => {
  await withMovableClaude(async ({ targetProject, targetProjectId }) => {
    await assertAppError(sessionsService.moveSessionToProject(SESSION_ID, 'no-such-project'), 404, 'PROJECT_NOT_FOUND');

    projectsDb.updateProjectIsArchived(targetProject, true);
    await assertAppError(sessionsService.moveSessionToProject(SESSION_ID, targetProjectId), 404, 'PROJECT_NOT_FOUND');
  });
});

test('a session that is running cannot be moved', async () => {
  await withMovableClaude(async ({ targetProjectId, forkCalls }) => {
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: 'native-source',
      connection: null,
      userId: null,
    });

    await assertAppError(sessionsService.moveSessionToProject(SESSION_ID, targetProjectId), 409, 'MOVE_SESSION_RUNNING');
    assert.equal(forkCalls.length, 0);
  });
});

test('a session with no transcript yet cannot be moved', async () => {
  await withMovableClaude(async ({ sourceProject, targetProjectId }) => {
    sessionsDb.createAppSession('fresh', 'claude', sourceProject, 'Fresh');
    await assertAppError(sessionsService.moveSessionToProject('fresh', targetProjectId), 409, 'MOVE_SOURCE_NOT_READY');
  });
});

test('a provider without fork support cannot move sessions', async () => {
  await withMovableClaude(async ({ targetProjectId }) => {
    await assertAppError(sessionsService.moveSessionToProject(SESSION_ID, targetProjectId), 409, 'MOVE_NOT_SUPPORTED');
  }, { disableFork: true });
});

test('moving a session that does not exist is a 404', async () => {
  await withMovableClaude(async ({ targetProjectId }) => {
    await assertAppError(sessionsService.moveSessionToProject('missing', targetProjectId), 404, 'SESSION_NOT_FOUND');
  });
});

// ── Claude: the copy has to land where Claude looks for it ─

type ClaudeHome = { projectsRoot: string; sourcePath: string; sourceProject: string; targetProject: string };

async function withClaudeHome(runTest: (home: ClaudeHome) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-move-'));
  const projectsRoot = path.join(root, 'projects');
  const sourceProject = path.join(root, 'work', 'source');
  const targetProject = path.join(root, 'work', 'target');
  const sourceFolder = path.join(projectsRoot, encodeClaudeProjectDirName(sourceProject));
  await mkdir(sourceFolder, { recursive: true });

  const sourcePath = path.join(sourceFolder, 'old-id.jsonl');
  await writeFile(sourcePath, [
    JSON.stringify({ type: 'user', sessionId: 'old-id', cwd: sourceProject, uuid: 'u1' }),
    'not json at all',
    JSON.stringify({ type: 'assistant', sessionId: 'old-id', cwd: sourceProject, uuid: 'u2' }),
    JSON.stringify({ type: 'summary', summary: 'no cwd here' }),
    '',
  ].join('\n'), 'utf8');

  try {
    await runTest({ projectsRoot, sourcePath, sourceProject, targetProject });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a Claude move forks from a copy staged in the target folder with the new directory', async () => {
  await withClaudeHome(async ({ projectsRoot, sourcePath, sourceProject, targetProject }) => {
    const targetFolder = path.join(projectsRoot, encodeClaudeProjectDirName(targetProject));
    const original = await readFile(sourcePath, 'utf8');
    const sdkCalls: Array<{ sessionId: string; dir: string; staged: string }> = [];

    const provider = new ClaudeForkProvider(async (sessionId, options) => {
      // What the SDK would find when it looks the session up in `dir`.
      const staged = await readFile(
        path.join(projectsRoot, encodeClaudeProjectDirName(options.dir), `${sessionId}.jsonl`),
        'utf8',
      );
      sdkCalls.push({ sessionId, dir: options.dir, staged });
      // The SDK writes the fork beside the transcript it found.
      await writeFile(path.join(targetFolder, 'new-id.jsonl'), staged.replaceAll('old-id', 'new-id'), 'utf8');
      return { sessionId: 'new-id' };
    });

    const result = await provider.forkSession({
      providerSessionId: 'old-id',
      jsonlPath: sourcePath,
      projectPath: sourceProject,
      targetProjectPath: targetProject,
    });

    assert.deepEqual(result, { providerSessionId: 'new-id', jsonlPath: path.join(targetFolder, 'new-id.jsonl') });
    assert.equal(sdkCalls.length, 1);
    assert.equal(sdkCalls[0].dir, targetProject);

    // Every entry that named the old directory names the new one; nothing else changed.
    const stagedLines = sdkCalls[0].staged.split('\n');
    assert.equal(JSON.parse(stagedLines[0]).cwd, targetProject);
    assert.equal(stagedLines[1], 'not json at all');
    assert.equal(JSON.parse(stagedLines[2]).cwd, targetProject);
    assert.equal(stagedLines[3], JSON.stringify({ type: 'summary', summary: 'no cwd here' }));

    // The stage is gone, only the fork remains; the original was not touched.
    assert.deepEqual(await readdir(targetFolder), ['new-id.jsonl']);
    assert.equal(await readFile(sourcePath, 'utf8'), original);
  });
});

test('a failed Claude fork leaves no staged copy behind', async () => {
  await withClaudeHome(async ({ projectsRoot, sourcePath, sourceProject, targetProject }) => {
    const provider = new ClaudeForkProvider(async () => {
      throw new Error('sdk exploded');
    });

    await assert.rejects(provider.forkSession({
      providerSessionId: 'old-id',
      jsonlPath: sourcePath,
      projectPath: sourceProject,
      targetProjectPath: targetProject,
    }), /sdk exploded/);

    assert.deepEqual(await readdir(path.join(projectsRoot, encodeClaudeProjectDirName(targetProject))), []);
  });
});

test('a Claude move will not overwrite a transcript already in the target folder', async () => {
  await withClaudeHome(async ({ projectsRoot, sourcePath, sourceProject, targetProject }) => {
    const targetFolder = path.join(projectsRoot, encodeClaudeProjectDirName(targetProject));
    await mkdir(targetFolder, { recursive: true });
    await writeFile(path.join(targetFolder, 'old-id.jsonl'), 'someone else\n', 'utf8');
    let forked = false;

    const provider = new ClaudeForkProvider(async () => {
      forked = true;
      return { sessionId: 'new-id' };
    });

    await assertAppError(provider.forkSession({
      providerSessionId: 'old-id',
      jsonlPath: sourcePath,
      projectPath: sourceProject,
      targetProjectPath: targetProject,
    }), 409, 'MOVE_TARGET_CONFLICT');

    assert.equal(forked, false);
    assert.equal(await readFile(path.join(targetFolder, 'old-id.jsonl'), 'utf8'), 'someone else\n');
  });
});

test('an ordinary Claude fork still forks in place', async () => {
  await withClaudeHome(async ({ sourcePath, sourceProject }) => {
    const dirs: string[] = [];
    const provider = new ClaudeForkProvider(async (_sessionId, options) => {
      dirs.push(options.dir);
      await writeFile(path.join(path.dirname(sourcePath), 'new-id.jsonl'), '{}\n', 'utf8');
      return { sessionId: 'new-id' };
    });

    const result = await provider.forkSession({
      providerSessionId: 'old-id',
      jsonlPath: sourcePath,
      projectPath: sourceProject,
    });

    assert.deepEqual(dirs, [sourceProject]);
    assert.equal(result.jsonlPath, path.join(path.dirname(sourcePath), 'new-id.jsonl'));
  });
});

test('the Claude indexer does not hand back a transcript a session moved off', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-move-index-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();

  try {
    const transcript = path.join(root, 'left-behind.jsonl');
    await writeFile(transcript, `${JSON.stringify({ sessionId: 'left-behind', cwd: path.join(root, 'old') })}\n`, 'utf8');
    sessionsDb.markProviderSessionSuperseded({
      providerSessionId: 'left-behind',
      provider: 'claude',
      sessionId: 'moved-session',
      jsonlPath: transcript,
    });

    const indexed = await new ClaudeSessionSynchronizer().synchronizeFile(transcript);

    assert.equal(indexed, null);
    assert.equal(sessionsDb.getAllSessions().length, 0);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The Claude move rests on SDK behavior this repo does not own: that
 * `forkSession` finds a session by the folder `dir` encodes to, and copies the
 * entries' working directory as it finds them. Runs the real SDK against a
 * throwaway CLAUDE_CONFIG_DIR — forking is a local file operation, no model is
 * called. The temp folder is deliberately left unresolved: on macOS it sits
 * behind the `/var` → `/private/var` symlink, which the SDK resolves.
 */
test('the Claude SDK forks a staged copy into the target project', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-move-real-'));
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-home');

  const sessionId = '11111111-2222-3333-4444-555555555555';
  const sourceProject = path.join(root, 'source');
  const targetProject = path.join(root, 'target');
  const timestamp = new Date().toISOString();
  const entries = [
    { parentUuid: null, isSidechain: false, userType: 'external', cwd: sourceProject, sessionId, version: '2.0.0', type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'aaaaaaaa-0000-0000-0000-000000000001', timestamp },
    { parentUuid: 'aaaaaaaa-0000-0000-0000-000000000001', isSidechain: false, userType: 'external', cwd: sourceProject, sessionId, version: '2.0.0', type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'aaaaaaaa-0000-0000-0000-000000000002', timestamp },
  ];
  const original = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

  try {
    await mkdir(sourceProject, { recursive: true });
    await mkdir(targetProject, { recursive: true });
    const realRoot = await realpath(root);
    const sourceFolder = path.join(root, 'claude-home', 'projects', encodeClaudeProjectDirName(path.join(realRoot, 'source')));
    await mkdir(sourceFolder, { recursive: true });
    const sourcePath = path.join(sourceFolder, `${sessionId}.jsonl`);
    await writeFile(sourcePath, original, 'utf8');

    const result = await new ClaudeForkProvider().forkSession({
      providerSessionId: sessionId,
      jsonlPath: sourcePath,
      projectPath: sourceProject,
      targetProjectPath: targetProject,
    });

    // Where Claude will look when it resumes in the target directory.
    const targetFolder = path.join(root, 'claude-home', 'projects', encodeClaudeProjectDirName(path.join(realRoot, 'target')));
    assert.equal(path.dirname(result.jsonlPath), targetFolder);
    assert.notEqual(result.providerSessionId, sessionId);
    assert.deepEqual(await readdir(targetFolder), [path.basename(result.jsonlPath)]);

    const copied = (await readFile(result.jsonlPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; cwd?: string; sessionId?: string })
      .filter((entry) => entry.type === 'user' || entry.type === 'assistant');
    assert.equal(copied.length, 2);
    for (const entry of copied) {
      assert.equal(entry.cwd, targetProject);
      assert.equal(entry.sessionId, result.providerSessionId);
    }

    assert.equal(await readFile(sourcePath, 'utf8'), original);
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(root, { recursive: true, force: true });
  }
});

// ── Codex ─────────────────────────────────────────────────

test('a Codex move forks with the target directory and pins it if the rollout disagrees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-move-'));
  const rollout = path.join(root, 'rollout-thread-2.jsonl');
  // A rollout whose first line still names the old directory.
  await writeFile(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread-2', cwd: '/old' } }),
    JSON.stringify({ type: 'turn_context', payload: { cwd: '/old' } }),
    '',
  ].join('\n'), 'utf8');

  const calls: unknown[] = [];
  try {
    const result = await new CodexForkProvider(async (input) => {
      calls.push(input);
      return { threadId: 'thread-2', path: rollout };
    }).forkSession({
      providerSessionId: 'thread-1',
      jsonlPath: '/sessions/rollout-thread-1.jsonl',
      projectPath: '/old',
      targetProjectPath: '/new',
    });

    assert.deepEqual(calls, [{ threadId: 'thread-1', lastTurnId: undefined, cwd: '/new' }]);
    assert.deepEqual(result, { providerSessionId: 'thread-2', jsonlPath: rollout });

    const [first, second] = (await readFile(rollout, 'utf8')).split('\n');
    assert.equal(JSON.parse(first).payload.cwd, '/new');
    assert.equal(JSON.parse(first).payload.id, 'thread-2');
    // Only the line the indexer reads is touched.
    assert.equal(JSON.parse(second).payload.cwd, '/old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an ordinary Codex fork does not rewrite the rollout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-fork-'));
  const rollout = path.join(root, 'rollout.jsonl');
  const content = `${JSON.stringify({ type: 'session_meta', payload: { id: 't2', cwd: '/elsewhere' } })}\n`;
  await writeFile(rollout, content, 'utf8');

  try {
    await new CodexForkProvider(async () => ({ threadId: 't2', path: rollout })).forkSession({
      providerSessionId: 't1',
      jsonlPath: '/sessions/t1.jsonl',
      projectPath: '/old',
    });
    assert.equal(await readFile(rollout, 'utf8'), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The move rests on a protocol this repo does not own: that `thread/fork`
 * writes the `cwd` it was given into the copy's opening `session_meta`, which
 * is the line the indexer files a thread by. Runs the real app-server against
 * a throwaway CODEX_HOME; no model is called.
 */
test('codex app-server records the requested directory in a forked thread', { concurrency: false }, async (t) => {
  try {
    createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js');
  } catch {
    t.skip('the Codex CLI package is not installed');
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-move-real-'));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;

  const threadId = '01a02a80-dfb9-7882-8013-00e41955e656';
  const sourceProject = path.join(root, 'source');
  const targetProject = path.join(root, 'target');
  const timestamp = '2026-08-22T11:24:44.000Z';

  try {
    await mkdir(sourceProject, { recursive: true });
    await mkdir(targetProject, { recursive: true });
    const sessionsDir = path.join(root, 'sessions', '2026', '08', '22');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, `rollout-2026-08-22T20-24-44-${threadId}.jsonl`), [
      { timestamp, type: 'session_meta', payload: { id: threadId, timestamp, cwd: sourceProject, originator: 'codex_exec', cli_version: '0.153.4', source: 'exec', model_provider: 'openai' } },
      { timestamp, type: 'turn_context', payload: { cwd: sourceProject, approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'gpt-5', summary: 'auto' } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'hello', images: [] } },
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');

    const fork = await codexAppServer.forkThread({ threadId, cwd: targetProject });

    const [firstLine] = (await readFile(fork.path, 'utf8')).split('\n');
    const first = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; cwd?: string } };
    assert.equal(first.type, 'session_meta');
    assert.equal(first.payload?.id, fork.threadId);
    assert.equal(first.payload?.cwd, targetProject);
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});
