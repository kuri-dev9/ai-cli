import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { forkSession as forkClaudeSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError, encodeClaudeProjectDirName } from '@/shared/utils.js';

/** The SDK call this provider makes; swapped out by tests, which have no real Claude session. */
type ClaudeSessionForker = (
  sessionId: string,
  options: { dir: string; upToMessageId?: string; title?: string },
) => Promise<{ sessionId?: string }>;

/**
 * Points every transcript entry recorded in `fromPath` at `toPath`.
 *
 * Claude stamps the working directory on each entry, and the session indexer
 * files a transcript under whatever its first entry says. Lines that are not
 * JSON, or that name some other directory, are left exactly as they were.
 */
function rewriteTranscriptCwd(content: string, fromPath: string, toPath: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (!line.trim()) {
        return line;
      }
      try {
        const entry = JSON.parse(line) as unknown;
        if (entry && typeof entry === 'object' && (entry as { cwd?: unknown }).cwd === fromPath) {
          return JSON.stringify({ ...(entry as Record<string, unknown>), cwd: toPath });
        }
      } catch {
        // Not ours to repair; the SDK reads past it as it did before.
      }
      return line;
    })
    .join('\n');
}

async function assertTranscriptWritten(transcriptPath: string): Promise<void> {
  try {
    await stat(transcriptPath);
  } catch {
    throw new AppError('Claude reported a fork but wrote no transcript for it.', {
      code: 'FORK_FAILED',
      statusCode: 502,
    });
  }
}

/**
 * Branches a Claude conversation by copying its transcript into a new session
 * file.
 *
 * The SDK owns this: it remaps every message uuid and rewrites the parentUuid
 * chain, which is what makes the copy resumable rather than just a duplicate
 * file. `upToMessageId` is inclusive of the row it names.
 */
export class ClaudeForkProvider implements IProviderFork {
  constructor(private readonly forkWithSdk: ClaudeSessionForker = forkClaudeSession) {}

  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    targetProjectPath?: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    if (input.targetProjectPath && input.targetProjectPath !== input.projectPath) {
      return this.forkIntoProject({ ...input, targetProjectPath: input.targetProjectPath });
    }

    // `dir` is the session's working directory, which the SDK encodes into the
    // `~/.claude/projects/<encoded>` folder name itself — passing that folder
    // makes it encode an already-encoded path and find nothing.
    const sessionId = await this.fork(input.providerSessionId, input.projectPath, input);

    // Confirmed rather than assumed: the caller is about to write a database
    // row claiming this file exists, and a half-created row would show up in
    // the sidebar as a session that can never be opened.
    // The fork lands beside the transcript it was copied from.
    const forkedPath = path.join(path.dirname(input.jsonlPath), `${sessionId}.jsonl`);
    await assertTranscriptWritten(forkedPath);

    return { providerSessionId: sessionId, jsonlPath: forkedPath };
  }

  private async fork(
    providerSessionId: string,
    dir: string,
    input: { upToAnchorId?: string; title?: string },
  ): Promise<string> {
    const { sessionId } = await this.forkWithSdk(providerSessionId, {
      dir,
      upToMessageId: input.upToAnchorId,
      title: input.title,
    });

    if (!sessionId) {
      throw new AppError('Claude did not return a session id for the fork.', {
        code: 'FORK_FAILED',
        statusCode: 502,
      });
    }
    return sessionId;
  }

  /**
   * Forks a conversation so the copy lives in another project.
   *
   * The SDK always writes a fork beside its source and copies the source's
   * working directory into it, so it cannot do this on its own. Instead the
   * source transcript is staged in the target project's folder with its
   * working directory rewritten, and the SDK forks *that*: the copy lands in
   * the target folder already naming the target directory, which is where
   * Claude looks on resume and what the session indexer reads.
   *
   * The staged file shares the source's session id. It is removed as soon as
   * the fork exists, and the caller records the source as superseded, so the
   * indexer never offers it as a conversation of its own. The original
   * transcript is not touched.
   */
  private async forkIntoProject(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    targetProjectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // The source's folder sits directly under `<claude-home>/projects`. Taking
    // the root from it, rather than from the environment, keeps the copy in
    // the same Claude home as the conversation it came from.
    const projectsRoot = path.dirname(path.dirname(input.jsonlPath));
    // The SDK resolves symlinks in `dir` before it looks for the session, so
    // the stage has to sit in the folder named after the resolved path. The
    // entries keep the path the project is registered under — that is what
    // the indexer has to match.
    const resolvedTarget = await realpath(input.targetProjectPath).catch(() => input.targetProjectPath);
    const targetFolder = path.join(projectsRoot, encodeClaudeProjectDirName(resolvedTarget));
    const stagedPath = path.join(targetFolder, `${input.providerSessionId}.jsonl`);

    const sourceContent = await readFile(input.jsonlPath, 'utf8');
    await mkdir(targetFolder, { recursive: true });
    try {
      // `wx`: a transcript with this id already in the target folder is not
      // ours to overwrite — it would be a real conversation, not a stage.
      await writeFile(
        stagedPath,
        rewriteTranscriptCwd(sourceContent, input.projectPath, input.targetProjectPath),
        { flag: 'wx' },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      throw new AppError('A transcript with this id already exists in the target project.', {
        code: 'MOVE_TARGET_CONFLICT',
        statusCode: 409,
      });
    }

    try {
      const sessionId = await this.fork(input.providerSessionId, input.targetProjectPath, input);
      const forkedPath = path.join(targetFolder, `${sessionId}.jsonl`);
      await assertTranscriptWritten(forkedPath);
      return { providerSessionId: sessionId, jsonlPath: forkedPath };
    } finally {
      await rm(stagedPath, { force: true });
    }
  }
}
