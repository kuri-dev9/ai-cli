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
  sessionSharesDb,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  createSessionShare,
  readGuestEvents,
  readGuestSnapshot,
  resolveActiveShare,
  sendGuestMessage,
  toGuestMessage,
} from '@/modules/session-share/services/session-share.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * 세션 공유 링크.
 *
 * 지켜야 할 것은 셋이다. 하나, 끊었거나 기한이 지난 링크로는 아무것도 할 수
 * 없다. 둘, 게스트 질문은 링크에 적힌 권한으로만 실행된다. 셋, 게스트에게는
 * 대화를 따라갈 만큼만 내려가고 도구 결과 본문은 나가지 않는다.
 */

const SESSION_ID = 'shared-session';

type RunCall = { command: string; options: Record<string, unknown> };

/** 실행을 붙잡아 둘 수 있는 가짜 런타임. `release` 를 부르기 전까지 실행 중이다. */
function createFakeRuntime() {
  const calls: RunCall[] = [];
  let release: () => void = () => {};
  const runtime = {
    hasRuntime: () => true,
    abort: async () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [] as unknown[],
    run: async (
      _provider: string,
      command: string,
      options: Record<string, unknown>,
      writer: { send: (message: NormalizedMessage) => void },
    ) => {
      calls.push({ command, options });
      writer.send({
        id: 'delta-1',
        sessionId: SESSION_ID,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        kind: 'stream_delta',
        content: '답을 쓰는 ',
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  return { runtime, calls, release: () => release() };
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-share-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    projectsDb.createProjectPath(tempDirectory, 'Share Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Shared session');
    await runTest();
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

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('끊었거나 기한이 지난 링크는 열리지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    const share = createSessionShare({
      sessionId: SESSION_ID,
      userId: 1,
      permissionMode: 'default',
      expiresInHours: 24,
    });
    assert.equal(resolveActiveShare(share.token).sessionId, SESSION_ID);
    assert.equal(sessionSharesDb.listActiveBySession(SESSION_ID).length, 1);

    sessionSharesDb.revoke(share.id);
    assert.throws(() => resolveActiveShare(share.token), { code: 'SHARE_NOT_FOUND' });
    assert.equal(sessionSharesDb.listActiveBySession(SESSION_ID).length, 0);

    // 기한이 지난 링크. 만료는 읽을 때 판단한다.
    const expired = sessionSharesDb.create({
      token: 'expired-token',
      sessionId: SESSION_ID,
      permissionMode: 'default',
      createdBy: 1,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    assert.throws(() => resolveActiveShare(expired.token), { code: 'SHARE_NOT_FOUND' });

    // 없는 토큰도 같은 답이다. 있던 링크인지 아닌지 알려 주지 않는다.
    assert.throws(() => resolveActiveShare('no-such-token'), { code: 'SHARE_NOT_FOUND' });
  });
});

test('게스트 질문은 링크에 적힌 권한으로 실행되고 게스트 배지가 붙는다', async () => {
  await withIsolatedDatabase(async () => {
    const { runtime, calls, release } = createFakeRuntime();
    const share = createSessionShare({
      sessionId: SESSION_ID,
      userId: 1,
      permissionMode: 'acceptEdits',
      expiresInHours: null,
    });

    await sendGuestMessage(share.token, '  이 함수 설명해줘  ', runtime as never);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '이 함수 설명해줘');
    assert.equal(calls[0].options.permissionMode, 'acceptEdits');
    assert.equal(calls[0].options.skipPermissions, undefined);

    // 실행 중에는 쓰이는 중인 답과, 게스트가 보낸 글(배지 포함)이 내려간다.
    const live = readGuestEvents(share.token, runtime as never, { runKey: null, afterSeq: 0 });
    assert.equal(live.isProcessing, true);
    assert.ok(live.runKey);
    const echo = live.events.find((event) => event.kind === 'text');
    assert.equal(echo?.kind === 'text' && echo.source, 'share');
    assert.ok(live.events.some((event) => event.kind === 'delta' && event.content === '답을 쓰는 '));

    // 이미 받은 것은 다시 오지 않는다.
    const again = readGuestEvents(share.token, runtime as never, { runKey: live.runKey, afterSeq: live.lastSeq });
    assert.equal(again.events.length, 0);

    // 작업 중에는 줄을 세우지 않고 거절한다.
    await assert.rejects(
      sendGuestMessage(share.token, '하나 더', runtime as never),
      { code: 'SHARE_SESSION_BUSY' },
    );

    // 주인이 권한을 바꾸면 열린 링크도 따라간다.
    sessionSharesDb.updatePermissionForSession(SESSION_ID, 'bypassPermissions');

    release();
    await settle();
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), false);

    await sendGuestMessage(share.token, '이번엔 고쳐줘', runtime as never);
    assert.equal(calls[1].options.permissionMode, 'bypassPermissions');
    // Cursor 는 이 값을 본다.
    assert.equal(calls[1].options.skipPermissions, true);
    release();
    await settle();

    // 기록에 붙일 출처가 남아 있다.
    const annotated = messageSourcesDb.annotateMessageSources<{
      role: 'user';
      content: string;
      timestamp: string;
      source?: 'telegram' | 'share';
    }>(SESSION_ID, [
      { role: 'user', content: '이 함수 설명해줘', timestamp: new Date(Date.now() + 1_000).toISOString() },
    ]);
    assert.equal(annotated[0].source, 'share');
  });
});

test('빈 글과 너무 긴 글은 받지 않는다', async () => {
  await withIsolatedDatabase(async () => {
    const { runtime, calls } = createFakeRuntime();
    const share = createSessionShare({
      sessionId: SESSION_ID,
      userId: 1,
      permissionMode: 'default',
      expiresInHours: 1,
    });

    await assert.rejects(sendGuestMessage(share.token, '   ', runtime as never), { code: 'SHARE_MESSAGE_EMPTY' });
    await assert.rejects(
      sendGuestMessage(share.token, 'a'.repeat(8_001), runtime as never),
      { code: 'SHARE_MESSAGE_TOO_LONG' },
    );
    assert.equal(calls.length, 0);
  });
});

test('처음 열면 세션 제목과 실행 상태를 받는다', async () => {
  await withIsolatedDatabase(async () => {
    const { runtime } = createFakeRuntime();
    const share = createSessionShare({
      sessionId: SESSION_ID,
      userId: 1,
      permissionMode: 'default',
      expiresInHours: 1,
    });

    const snapshot = await readGuestSnapshot(share.token, runtime as never);
    assert.equal(snapshot.title, 'Shared session');
    assert.equal(snapshot.isProcessing, false);
    assert.equal(snapshot.awaitingApproval, false);
    assert.deepEqual(snapshot.messages, []);
    assert.ok(snapshot.expiresAt);
  });
});

test('게스트에게는 대화와 도구 이름만 내려가고 도구 결과와 생각은 빠진다', () => {
  const base = { sessionId: SESSION_ID, timestamp: '2026-11-14T00:00:00.000Z', provider: 'claude' as const };

  assert.deepEqual(
    toGuestMessage({ ...base, id: 'u1', kind: 'text', role: 'user', content: '질문', source: 'share' }),
    { id: 'u1', kind: 'text', role: 'user', content: '질문', timestamp: base.timestamp, source: 'share' },
  );
  assert.deepEqual(
    toGuestMessage({ ...base, id: 't1', kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/repo/a.ts' } }),
    { id: 't1', kind: 'tool', toolName: 'Read', detail: '/repo/a.ts', timestamp: base.timestamp },
  );
  assert.equal(
    toGuestMessage({ ...base, id: 'r1', kind: 'tool_result', toolResult: { content: 'SECRET=1' } }),
    null,
  );
  assert.equal(toGuestMessage({ ...base, id: 'th', kind: 'thinking', content: '속으로 생각' }), null);
  assert.equal(
    toGuestMessage({ ...base, id: 'c1', kind: 'text', role: 'user', content: '요약', isCompactSummary: true }),
    null,
  );
});
