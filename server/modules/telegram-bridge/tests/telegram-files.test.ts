import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { dispatchQueuedMessages } from '@/modules/scheduled-messages/index.js';
import { handleTelegramCommand } from '@/modules/telegram-bridge/index.js';
import { startTelegramBridge } from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import { createTelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import type {
  TelegramClient,
  TelegramIncomingFile,
  TelegramUpdate,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { getGlobalImageAssetsDir } from '@/shared/image-attachments.js';

/** 답이 버튼을 달고 와도 글만 본다. */
function replyText(reply: Awaited<ReturnType<typeof handleTelegramCommand>>): string {
  return typeof reply === 'string' ? reply : reply?.text ?? '';
}

const SESSION_ID = 'telegram-files-session';
const CHAT_ID = 4242;
const BOT_TOKEN = '123456:secret-token';

/**
 * 첨부는 `~/.cloudcli/assets` 에 떨어진다. 실제 홈을 더럽히지 않도록 HOME 을
 * 임시 폴더로 돌린다 — 실행 직전 검사도 같은 HOME 을 보므로 경로가 맞는다.
 */
async function withIsolatedEnvironment(
  runTest: (context: { userId: number }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-files-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.HOME = tempDirectory;
  await initializeDatabase();

  try {
    const user = userDb.createUser('files', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Files Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Files session');
    await runTest({ userId: Number(user.id) });
  } finally {
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    process.env.HOME = previousHome;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

type RunCall = { command: string; options: Record<string, unknown> };

function createRuntime(runs: RunCall[]) {
  return {
    hasRuntime: () => true,
    run: async (_provider: string, command: string, options: Record<string, unknown>) => {
      runs.push({ command, options });
    },
    abort: async () => true,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
  } as never;
}

function photo(fileId: string, overrides: Partial<TelegramIncomingFile> = {}): TelegramIncomingFile {
  return {
    fileId,
    name: `telegram-photo-${fileId}.jpg`,
    mimeType: 'image/jpeg',
    size: 3,
    kind: 'photo',
    ...overrides,
  };
}

/** file id 를 그대로 내용으로 돌려준다. 어느 파일이 어디 저장됐는지 알아보기 쉽다. */
function createDownloader(downloads: string[] = []) {
  return async (fileId: string) => {
    downloads.push(fileId);
    return Buffer.from(fileId);
  };
}

async function listStoredAssets(): Promise<string[]> {
  try {
    return await readdir(getGlobalImageAssetsDir());
  } catch {
    return [];
  }
}

function attachmentPaths(options: Record<string, unknown>, key: 'images' | 'files'): string[] {
  return (options[key] as Array<{ path: string }>).map((descriptor) => descriptor.path);
}

/** 파일 저장은 실제 디스크를 거치므로 몇 바퀴 돌리는 것으로는 모자라다. */
async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      return;
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
}

// ── 갱신 해석 ─────────────────────────────────────────────

async function withStubbedFetch(
  respond: (url: string, body: Record<string, unknown>) => unknown,
  runTest: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const result = respond(url, body);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  try {
    await runTest();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('사진은 가장 큰 사본 하나만 쓰고 캡션을 본문으로 읽는다', async () => {
  await withStubbedFetch(() => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: CHAT_ID },
        caption: '이거 봐줘',
        media_group_id: 'album-1',
        photo: [
          { file_id: 'small', width: 90, height: 60, file_size: 1_000 },
          { file_id: 'large', width: 1280, height: 853, file_size: 90_000 },
          { file_id: 'medium', width: 320, height: 213, file_size: 9_000 },
        ],
      },
    }],
  }), async () => {
    const [update] = await createTelegramClient(BOT_TOKEN).getUpdates(0);
    assert.deepEqual(update.message, {
      messageId: 7,
      chatId: CHAT_ID,
      text: '이거 봐줘',
      files: [{
        fileId: 'large',
        name: 'telegram-photo-7.jpg',
        mimeType: 'image/jpeg',
        size: 90_000,
        kind: 'photo',
      }],
      mediaGroupId: 'album-1',
    });
  });
});

test('파일로 보낸 것은 원래 이름과 형식을 그대로 들고 온다', async () => {
  await withStubbedFetch(() => ({
    ok: true,
    result: [{
      update_id: 1,
      message: {
        message_id: 8,
        chat: { id: CHAT_ID },
        document: { file_id: 'doc', file_name: '로그.txt', mime_type: 'text/plain', file_size: 12 },
      },
    }],
  }), async () => {
    const [update] = await createTelegramClient(BOT_TOKEN).getUpdates(0);
    assert.equal(update.message?.text, '');
    assert.deepEqual(update.message?.files, [{
      fileId: 'doc',
      name: '로그.txt',
      mimeType: 'text/plain',
      size: 12,
      kind: 'document',
    }]);
    assert.equal(update.message?.mediaGroupId, null);
  });
});

test('글도 파일도 아닌 메시지는 지금처럼 버린다', async () => {
  await withStubbedFetch(() => ({
    ok: true,
    result: [{ update_id: 1, message: { message_id: 9, chat: { id: CHAT_ID }, sticker: { file_id: 's' } } }],
  }), async () => {
    const [update] = await createTelegramClient(BOT_TOKEN).getUpdates(0);
    assert.equal(update.message, null);
  });
});

test('파일은 getFile 로 경로를 얻어 파일 주소에서 받는다', async () => {
  const requested: string[] = [];
  await withStubbedFetch((url) => {
    requested.push(url);
    if (url.endsWith('/getFile')) {
      return { ok: true, result: { file_path: 'photos/file_1.jpg' } };
    }
    return new Response('jpeg-bytes', { status: 200 });
  }, async () => {
    const content = await createTelegramClient(BOT_TOKEN).downloadFile('large');
    assert.equal(content.toString(), 'jpeg-bytes');
    assert.equal(requested[1], `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/file_1.jpg`);
  });
});

test('내려받기 실패 문구에는 토큰이 남지 않는다', async () => {
  await withStubbedFetch((url) => {
    if (url.endsWith('/getFile')) {
      return { ok: true, result: { file_path: 'photos/file_1.jpg' } };
    }
    throw new Error(`fetch failed: ${url}`);
  }, async () => {
    await assert.rejects(
      createTelegramClient(BOT_TOKEN).downloadFile('large'),
      (error: Error) => !error.message.includes(BOT_TOKEN) && error.message.includes('***'),
    );
  });
});

// ── 세션으로 넘기기 ───────────────────────────────────────

test('사진은 첨부 폴더에 저장되어 캡션과 함께 이미지로 넘어간다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand(
      '이 화면 뭐가 문제야?',
      { userId, runtime, downloadFile: createDownloader() },
      [photo('shot-1'), photo('shot-2')],
    );

    assert.equal(reply, null);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, '이 화면 뭐가 문제야?');

    // 실행 직전 검사를 통과했다는 것은 첨부 폴더 바로 아래에 있다는 뜻이다.
    const images = attachmentPaths(runs[0].options, 'images');
    assert.equal(images.length, 2);
    for (const imagePath of images) {
      assert.equal(path.dirname(imagePath), getGlobalImageAssetsDir());
    }
    assert.equal(await readFile(images[0], 'utf8'), 'shot-1');
    assert.equal(await readFile(images[1], 'utf8'), 'shot-2');
  });
});

test('사진이 아닌 파일은 일반 첨부로 넘어간다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand(
      '요약해줘',
      { userId, runtime, downloadFile: createDownloader() },
      [{ fileId: 'report', name: 'report.pdf', mimeType: 'application/pdf', size: 6, kind: 'document' }],
    );

    assert.equal(attachmentPaths(runs[0].options, 'images').length, 0);
    const files = runs[0].options.files as Array<{ path: string; name: string }>;
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'report.pdf');
  });
});

test('캡션 없이 보내면 빈 본문 대신 안내 한 줄을 넣는다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand('', { userId, runtime, downloadFile: createDownloader() }, [photo('a')]);
    await handleTelegramCommand('', { userId, runtime, downloadFile: createDownloader() }, [
      { fileId: 'b', name: 'b.txt', mimeType: 'text/plain', size: 1, kind: 'document' },
    ]);

    assert.deepEqual(runs.map((run) => run.command), ['보낸 사진을 확인해 주세요.', '보낸 파일을 확인해 주세요.']);
  });
});

test('사진에 단 캡션은 슬래시로 시작해도 명령으로 읽지 않는다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand('/stop', { userId, runtime, downloadFile: createDownloader() }, [photo('a')]);

    assert.deepEqual(runs.map((run) => run.command), ['/stop']);
  });
});

test('사진 캡션의 /new 만은 명령이다 — 그 사진으로 새 대화를 연다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    await handleTelegramCommand(
      '/new codex 이 화면 봐줘',
      {
        userId,
        runtime,
        downloadFile: createDownloader(),
        listConnectedProviders: async () => ['claude', 'codex'],
      },
      [photo('shot')],
    );

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, '이 화면 봐줘');
    assert.notEqual(runs[0].options.sessionId, SESSION_ID);
    assert.equal(sessionsDb.getSessionById(String(runs[0].options.sessionId))?.provider, 'codex');
    assert.equal(attachmentPaths(runs[0].options, 'images').length, 1);
  });
});

test('구독 중인 대화가 없으면 파일을 받지도 않는다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const downloads: string[] = [];
    const reply = await handleTelegramCommand(
      '',
      { userId, runtime: createRuntime([]), downloadFile: createDownloader(downloads) },
      [photo('a')],
    );

    assert.match(replyText(reply), /구독 중인 세션이 없/);
    assert.equal(downloads.length, 0);
    assert.deepEqual(await listStoredAssets(), []);
  });
});

test('너무 많이 보내면 아무것도 받지 않고 거절한다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const downloads: string[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const files = Array.from({ length: 11 }, (_, index) => photo(`p${index}`));
    const reply = await handleTelegramCommand(
      '',
      { userId, runtime, downloadFile: createDownloader(downloads) },
      files,
    );

    assert.match(replyText(reply), /10개까지/);
    assert.equal(runs.length, 0);
    assert.equal(downloads.length, 0);
  });
});

test('크기 한도를 넘는 사진은 받기 전에 거절하고 안내한다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const downloads: string[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand(
      '',
      { userId, runtime, downloadFile: createDownloader(downloads) },
      [photo('huge', { kind: 'document', name: 'huge.png', mimeType: 'image/png', size: 8 * 1024 * 1024 })],
    );

    assert.match(replyText(reply), /사진으로 보내면/);
    assert.equal(runs.length, 0);
    assert.equal(downloads.length, 0);
  });
});

test('하나라도 받지 못하면 먼저 저장한 것까지 지우고 턴을 시작하지 않는다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const reply = await handleTelegramCommand(
      '',
      {
        userId,
        runtime,
        downloadFile: async (fileId) => {
          if (fileId === 'broken') {
            throw new Error('network down');
          }
          return Buffer.from(fileId);
        },
      },
      [photo('ok'), photo('broken')],
    );

    assert.match(replyText(reply), /첨부를 받지 못했습니다: network down/);
    assert.equal(runs.length, 0);
    assert.deepEqual(await listStoredAssets(), []);
  });
});

test('작업 중에 보낸 사진은 대기열을 거쳐도 첨부가 따라간다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const reply = await handleTelegramCommand(
      '이것도',
      { userId, runtime, downloadFile: createDownloader() },
      [photo('queued')],
    );
    assert.match(replyText(reply), /대기열에 넣었습니다/);

    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    await dispatchQueuedMessages(runtime, SESSION_ID);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, '이것도');
    assert.equal(attachmentPaths(runs[0].options, 'images').length, 1);
  });
});

// ── 앨범 ──────────────────────────────────────────────────

/**
 * 갱신을 묶음 단위로 내주는 가짜 텔레그램. 묶음이 떨어지면 짧게 묻는 호출에는
 * 빈 응답을, 길게 매달리는 호출에는 멈출 때까지 응답하지 않는다.
 */
function createScriptedClient(batches: TelegramUpdate[][], timeouts: Array<number | undefined>) {
  const queue = [...batches];
  return {
    getUpdates: (_offset: number, signal?: AbortSignal, timeoutSeconds?: number) => {
      timeouts.push(timeoutSeconds);
      const next = queue.shift();
      if (next) {
        return Promise.resolve(next);
      }
      if (timeoutSeconds !== undefined) {
        return Promise.resolve([]);
      }
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      });
    },
    getMe: async () => ({ username: 'test_bot' }),
    sendMessage: async () => {},
    downloadFile: async (fileId: string) => Buffer.from(fileId),
    requestTimeoutMs: 1_000,
  } as unknown as TelegramClient;
}

function albumUpdate(updateId: number, fileId: string, caption = ''): TelegramUpdate {
  return {
    updateId,
    message: {
      messageId: updateId,
      chatId: CHAT_ID,
      text: caption,
      files: [photo(fileId)],
      mediaGroupId: 'album-1',
    },
  };
}

function textUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    updateId,
    message: { messageId: updateId, chatId: CHAT_ID, text, files: [], mediaGroupId: null },
  };
}

test('나뉘어 도착한 앨범도 한 턴으로 묶어 보낸다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const timeouts: Array<number | undefined> = [];
    const bridge = startTelegramBridge({
      botToken: BOT_TOKEN,
      allowedChatIds: [CHAT_ID],
      runtime,
      client: createScriptedClient([
        [albumUpdate(1, 'one', '세 장 비교해줘')],
        [albumUpdate(2, 'two'), albumUpdate(3, 'three')],
      ], timeouts),
    });

    await waitUntil(() => runs.length > 0 && timeouts.length >= 4);
    bridge.stop();

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, '세 장 비교해줘');
    assert.equal(attachmentPaths(runs[0].options, 'images').length, 3);
    // 첫 장 뒤로는 나머지를 기다리느라 짧게 물었고, 다 온 뒤에야 다시 길게 매달린다.
    assert.deepEqual(timeouts.slice(0, 4), [undefined, 2, 2, undefined]);
  });
});

test('앨범 뒤에 바로 보낸 글은 앨범이 먼저 들어간 다음에 들어간다', async () => {
  await withIsolatedEnvironment(async ({ userId }) => {
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await handleTelegramCommand('/watch 1', { userId, runtime });

    const bridge = startTelegramBridge({
      botToken: BOT_TOKEN,
      allowedChatIds: [CHAT_ID],
      runtime,
      client: createScriptedClient([
        [albumUpdate(1, 'one', '앨범'), albumUpdate(2, 'two'), textUpdate(3, '그리고 이것도')],
      ], []),
    });

    await waitUntil(() => runs.length > 0);
    bridge.stop();

    // 앨범 턴이 돌고 있는 사이에 온 글은 대기열로 간다. 순서가 바뀌지 않았다는
    // 것은 앨범이 먼저 실행됐다는 것으로 확인한다.
    assert.equal(runs[0].command, '앨범');
    assert.equal(attachmentPaths(runs[0].options, 'images').length, 2);
  });
});
