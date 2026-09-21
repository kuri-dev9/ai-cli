import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  messageSourcesDb,
  projectsDb,
  sessionDraftsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import type { MessageSource } from '@/modules/database/index.js';
import { handleTelegramCommand } from '@/modules/telegram-bridge/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';

const SESSION_ID = 'telegram-source-session';

async function withIsolatedDatabase(
  runTest: (context: { userId: number; projectPath: string }) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-source-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('source', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Source Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Source session');
    await runTest({ userId: Number(user.id), projectPath: tempDirectory });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { command: string };

function createRuntime(runs: RunCall[]) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string) => {
      runs.push({ command });
    },
    abort: async () => true,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
  } as never;
}

/**
 * CLI 가 기록에 남기는 사용자 메시지의 최소 모양.
 *
 * `transcriptAnchorId` 는 Claude 가 붙이는 행 uuid 다. 출처를 이 uuid 에
 * 고정하는 동작을 확인하려면 실제와 같은 자리에 있어야 한다.
 */
type TranscriptRow = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  transcriptAnchorId?: string;
  /** 붙기 전에는 비어 있다. 붙었는지 확인하려면 자리가 있어야 한다. */
  source?: MessageSource;
};

function transcriptUserMessage(content: string, anchorId?: string): TranscriptRow {
  return {
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    ...(anchorId ? { transcriptAnchorId: anchorId } : {}),
  };
}

test('텔레그램에서 보낸 프롬프트는 본문 그대로 실행되고 출처가 남는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    await handleTelegramCommand('/watch 1', { userId, runtime });
    const reply = await handleTelegramCommand('테스트 돌려줘', { userId, runtime });

    assert.equal(reply, null);
    // 모델이 읽는 글에 "[텔레그램]" 같은 것이 섞이면 안 된다.
    assert.deepEqual(runs.map((run) => run.command), ['테스트 돌려줘']);

    const annotated = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      transcriptUserMessage('테스트 돌려줘', 'uuid-1'),
    ]);
    assert.equal(annotated[0].source, 'telegram');
    // 붙이는 쪽도 본문을 건드리지 않는다.
    assert.equal(annotated[0].content, '테스트 돌려줘');
  });
});

test('작업 중이라 대기열을 거친 메시지도 출처가 남는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    await handleTelegramCommand('/watch 1', { userId, runtime });

    // 브라우저에서 시작한 턴이 돌고 있는 상황.
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const reply = await handleTelegramCommand('이것도 해줘', { userId, runtime });
    assert.match(reply ?? '', /대기열에 넣었습니다/);
    assert.equal(runs.length, 0);

    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    await dispatchQueuedMessages(runtime, SESSION_ID);

    assert.deepEqual(runs.map((run) => run.command), ['이것도 해줘']);
    assert.equal(sessionDraftsDb.countQueuedMessages(userId, SESSION_ID), 0);

    const annotated = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      transcriptUserMessage('이것도 해줘', 'uuid-queued'),
    ]);
    assert.equal(annotated[0].source, 'telegram');
  });
});

test('브라우저에서 친 메시지에는 출처가 붙지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    const annotated = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      transcriptUserMessage('브라우저에서 친 것', 'uuid-browser'),
    ]);
    assert.equal(annotated[0].source, undefined);
  });
});

test('같은 글을 브라우저에서 또 보내도 표시가 옮겨 붙지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    await handleTelegramCommand('/watch 1', { userId, runtime });
    await handleTelegramCommand('계속', { userId, runtime });

    // 첫 조회에서 텔레그램 메시지에 표시가 붙고, 그 행 uuid 에 고정된다.
    const first = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      transcriptUserMessage('계속', 'uuid-telegram'),
    ]);
    assert.equal(first[0].source, 'telegram');

    // 나중에 브라우저에서 같은 글을 보낸 뒤 다시 조회하면, 표시는 처음
    // 고정된 메시지에만 남아 있어야 한다.
    const second = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      transcriptUserMessage('계속', 'uuid-telegram'),
      transcriptUserMessage('계속', 'uuid-browser'),
    ]);
    assert.equal(second[0].source, 'telegram');
    assert.equal(second[1].source, undefined);
  });
});

test('보내지 못한 턴의 표시는 남지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    // 프로바이더가 없어 턴이 시작되지 못하는 런타임.
    const runtime = {
      hasRuntime: () => false,
      run: async () => {},
      abort: async () => true,
      getPendingApprovalsForSession: () => [],
      resolveToolApproval: () => {},
    } as never;

    await handleTelegramCommand('/watch 1', { userId, runtime: createRuntime(runs) });
    const reply = await handleTelegramCommand('안 될 명령', { userId, runtime });

    assert.match(reply ?? '', /보내지 못했습니다/);

    const annotated = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      transcriptUserMessage('안 될 명령', 'uuid-failed'),
    ]);
    assert.equal(annotated[0].source, undefined);
  });
});

test('사용자 메시지가 아닌 행에는 출처를 붙이지 않는다', async () => {
  await withIsolatedDatabase(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    await handleTelegramCommand('/watch 1', { userId, runtime });
    await handleTelegramCommand('응답 확인', { userId, runtime });

    const annotated = messageSourcesDb.annotateMessageSources(SESSION_ID, [
      { role: 'assistant', content: '응답 확인', timestamp: new Date().toISOString() } as TranscriptRow,
    ]);
    assert.equal(annotated[0].source, undefined);
  });
});
