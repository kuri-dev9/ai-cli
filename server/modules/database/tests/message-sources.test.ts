import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, messageSourcesDb } from '@/modules/database/index.js';

/**
 * 앱 바깥에서 들어온 메시지에 출처를 붙이는 규칙.
 *
 * 여기서 제일 중요한 것은 "붙이지 않아야 할 때 붙이지 않는 것"이다. 브라우저에서
 * 친 메시지에 "텔레그램" 이 잘못 붙으면 기록 전체를 믿을 수 없게 된다. 표시가
 * 하나 빠지는 쪽이 훨씬 낫다.
 */

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'message-sources-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
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

type TestMessage = {
  transcriptAnchorId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant';
  content?: string;
  source?: 'telegram';
};

const laterThanNow = () => new Date(Date.now() + 1_000).toISOString();

test('텔레그램에서 온 메시지에만 출처가 붙는다', async () => {
  await withIsolatedDatabase(() => {
    messageSourcesDb.markMessageSource('session-1', '빌드 돌려줘', 'telegram');

    const annotated = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '빌드 돌려줘', timestamp: laterThanNow() },
      { role: 'user', content: '브라우저에서 친 글', timestamp: laterThanNow() },
    ]);

    assert.equal(annotated[0].source, 'telegram');
    assert.equal(annotated[1].source, undefined);
  });
});

test('본문은 그대로 둔다 — 프롬프트에 표시를 섞지 않는다', async () => {
  await withIsolatedDatabase(() => {
    const original = '빌드 돌려줘';
    messageSourcesDb.markMessageSource('session-1', original, 'telegram');

    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: original, timestamp: laterThanNow() },
    ]);

    assert.equal(annotated.content, original);
  });
});

test('표시 하나는 메시지 하나에만 붙는다', async () => {
  await withIsolatedDatabase(() => {
    // 텔레그램에서 한 번 보냈고, 같은 글을 브라우저에서 또 보낸 경우.
    messageSourcesDb.markMessageSource('session-1', '다시 해줘', 'telegram');

    const annotated = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '다시 해줘', timestamp: laterThanNow() },
      { role: 'user', content: '다시 해줘', timestamp: laterThanNow() },
    ]);

    assert.equal(annotated[0].source, 'telegram');
    assert.equal(annotated[1].source, undefined);
  });
});

test('한 번 맞춘 표시는 uuid 로 고정되어 다른 메시지로 옮겨 가지 않는다', async () => {
  await withIsolatedDatabase(() => {
    messageSourcesDb.markMessageSource('session-1', '다시 해줘', 'telegram');

    const first = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '다시 해줘', transcriptAnchorId: 'uuid-a', timestamp: laterThanNow() },
    ]);
    assert.equal(first[0].source, 'telegram');

    // 같은 글을 브라우저에서 또 보냈다. 고정된 표시는 원래 자리에 남아야 한다.
    const second = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '다시 해줘', transcriptAnchorId: 'uuid-a', timestamp: laterThanNow() },
      { role: 'user', content: '다시 해줘', transcriptAnchorId: 'uuid-b', timestamp: laterThanNow() },
    ]);

    assert.equal(second[0].source, 'telegram');
    assert.equal(second[1].source, undefined);
  });
});

test('적어 두기 전의 메시지에는 붙지 않는다', async () => {
  await withIsolatedDatabase(() => {
    messageSourcesDb.markMessageSource('session-1', '빌드 돌려줘', 'telegram');

    // 어제 같은 글을 브라우저에서 보냈던 기록.
    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      {
        role: 'user',
        content: '빌드 돌려줘',
        timestamp: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      },
    ]);

    assert.equal(annotated.source, undefined);
  });
});

test('대기열을 거쳐 한참 뒤에 실행된 메시지에도 붙는다', async () => {
  await withIsolatedDatabase(() => {
    messageSourcesDb.markMessageSource('session-1', '끝나면 이거 해줘', 'telegram');

    // 앞 턴이 길어 두 시간 뒤에 실행됐다. 위쪽은 막지 않는다.
    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      {
        role: 'user',
        content: '끝나면 이거 해줘',
        timestamp: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
      },
    ]);

    assert.equal(annotated.source, 'telegram');
  });
});

test('다른 세션의 표시는 넘어오지 않는다', async () => {
  await withIsolatedDatabase(() => {
    messageSourcesDb.markMessageSource('session-1', '빌드 돌려줘', 'telegram');

    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-2', [
      { role: 'user', content: '빌드 돌려줘', timestamp: laterThanNow() },
    ]);

    assert.equal(annotated.source, undefined);
  });
});

test('어시스턴트 답변에는 붙지 않는다', async () => {
  await withIsolatedDatabase(() => {
    messageSourcesDb.markMessageSource('session-1', '빌드 돌려줘', 'telegram');

    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'assistant', content: '빌드 돌려줘', timestamp: laterThanNow() },
    ]);

    assert.equal(annotated.source, undefined);
  });
});

test('표시가 하나도 없는 세션은 손대지 않는다', async () => {
  await withIsolatedDatabase(() => {
    const messages: TestMessage[] = [{ role: 'user', content: '아무 글', timestamp: laterThanNow() }];
    const annotated = messageSourcesDb.annotateMessageSources('session-1', messages);

    assert.deepEqual(annotated, messages);
  });
});

test('쓰이지 못한 표시를 지우면 나중에 같은 글에 붙지 않는다', async () => {
  await withIsolatedDatabase(() => {
    // 텔레그램에서 보냈으나 턴이 시작되지 못한 경우.
    const markId = messageSourcesDb.markMessageSource('session-1', '빌드 돌려줘', 'telegram');
    messageSourcesDb.dropMessageSource(markId);

    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '빌드 돌려줘', timestamp: laterThanNow() },
    ]);

    assert.equal(annotated.source, undefined);
  });
});

test('이미 메시지에 고정된 표시는 지워지지 않는다', async () => {
  await withIsolatedDatabase(() => {
    const markId = messageSourcesDb.markMessageSource('session-1', '빌드 돌려줘', 'telegram');
    messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '빌드 돌려줘', transcriptAnchorId: 'uuid-a', timestamp: laterThanNow() },
    ]);

    messageSourcesDb.dropMessageSource(markId);

    const [annotated] = messageSourcesDb.annotateMessageSources<TestMessage>('session-1', [
      { role: 'user', content: '빌드 돌려줘', transcriptAnchorId: 'uuid-a', timestamp: laterThanNow() },
    ]);
    assert.equal(annotated.source, 'telegram');
  });
});
