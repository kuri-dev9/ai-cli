import { readFile, writeFile } from 'node:fs/promises';

import { codexAppServer } from '@/modules/providers/list/codex/codex-app-server.client.js';
import type { IProviderFork } from '@/shared/interfaces.js';

/** The app-server call this provider makes; swapped out by tests, which have no Codex thread. */
type CodexThreadForker = (input: {
  threadId: string;
  lastTurnId?: string;
  cwd: string;
}) => Promise<{ threadId: string; path: string }>;

/**
 * Makes sure a rollout's opening `session_meta` names `cwd`.
 *
 * The session indexer files a Codex thread under the directory that first
 * line records. `thread/fork` is asked for the new directory and should
 * already have written it; this only repairs a rollout where it did not, so a
 * moved conversation cannot drift back to its old project on the next sync.
 */
async function pinRolloutCwd(rolloutPath: string, cwd: string): Promise<void> {
  const content = await readFile(rolloutPath, 'utf8');
  const lineEnd = content.indexOf('\n');
  const firstLine = lineEnd < 0 ? content : content.slice(0, lineEnd);

  let entry: { type?: unknown; payload?: Record<string, unknown> };
  try {
    entry = JSON.parse(firstLine) as typeof entry;
  } catch {
    return;
  }
  if (entry.type !== 'session_meta' || !entry.payload || entry.payload.cwd === cwd) {
    return;
  }

  const pinned = JSON.stringify({ ...entry, payload: { ...entry.payload, cwd } });
  await writeFile(rolloutPath, lineEnd < 0 ? pinned : `${pinned}${content.slice(lineEnd)}`);
}

/**
 * Branches a Codex conversation into an independent thread.
 *
 * `thread/fork` writes a real rollout with its own thread id and a
 * `forked_from_id` back-reference, which is what makes the copy resumable
 * rather than an inert duplicate of the file.
 *
 * One difference from the Claude fork worth knowing about: Codex's unit is a
 * turn, not a row. `upToAnchorId` names the turn a user message belongs to and
 * the cut is inclusive of it, so forking from a message keeps that message
 * *and the answer it got*. Claude's `upToMessageId` can stop at the prompt
 * itself. There is no way to express the finer cut here — a turn is written as
 * one thing — and the coarser one is the more useful of the two anyway.
 */
export class CodexForkProvider implements IProviderFork {
  constructor(
    private readonly forkThread: CodexThreadForker = (input) => codexAppServer.forkThread(input),
  ) {}

  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    targetProjectPath?: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // Codex rollouts are filed by date, not by directory, so moving to another
    // project is just a fork that runs somewhere else: `cwd` is the forked
    // thread's working directory.
    const cwd = input.targetProjectPath || input.projectPath;

    // `title` is deliberately not forwarded. The sidebar name lives in this
    // app's own session row, and naming the thread inside Codex would mean a
    // second call that could fail after the fork already succeeded.
    const fork = await this.forkThread({
      threadId: input.providerSessionId,
      lastTurnId: input.upToAnchorId,
      cwd,
    });

    if (input.targetProjectPath && input.targetProjectPath !== input.projectPath) {
      await pinRolloutCwd(fork.path, input.targetProjectPath);
    }

    // The path is the one the server reported and already confirmed on disk,
    // not one derived from the source: a fork lands in today's date directory
    // rather than beside the transcript it was copied from.
    return { providerSessionId: fork.threadId, jsonlPath: fork.path };
  }
}
