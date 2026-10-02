import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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
import { startTelegramBridge } from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import { createTelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import type { TelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * 턴이 끝나면 이 턴에 AI 가 만든 이미지가 완료 메시지 뒤에 따라간다.
 *
 * 이미지 외의 파일, 이 턴 전에 있던 파일, 이름만 이미지인 파일, 사용자가
 * 보낸 첨부는 가지 않는다 — 그것까지 지킨다.
 */

const SESSION_ID = 'turn-images-session';
const CHAT_ID = 4242;

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

type Outgoing =
  | { kind: 'message'; text: string }
  | { kind: 'photo' | 'document'; name: string; size: number };

type Harness = {
  projectPath: string;
  outgoing: Outgoing[];
  /** 프로바이더 흉내. 넘긴 함수가 실행 중에 파일을 쓰고 이벤트를 낸다. */
  runTurn: (during: (writer: ProviderRuntimeWriter) => Promise<void>) => Promise<void>;
};

function createFakeClient(outgoing: Outgoing[], options: { refusePhotos?: boolean } = {}): TelegramClient {
  return {
    getUpdates: (_offset: number, signal?: AbortSignal) =>
      new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
    getMe: async () => ({ username: 'test_bot' }),
    sendMessage: async (_chatId: number, text: string) => {
      outgoing.push({ kind: 'message', text });
    },
    sendPhoto: async (_chatId: number, content: Buffer, name: string) => {
      if (options.refusePhotos) {
        throw new Error('Telegram sendPhoto failed: PHOTO_INVALID_DIMENSIONS');
      }
      outgoing.push({ kind: 'photo', name, size: content.length });
    },
    sendDocument: async (_chatId: number, content: Buffer, name: string) => {
      outgoing.push({ kind: 'document', name, size: content.length });
    },
    requestTimeoutMs: 1_000,
  } as unknown as TelegramClient;
}

/** 이미지 전송은 디스크를 거치므로 완료 이벤트 한 바퀴로는 끝나지 않는다. */
async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
}

/** 보낼 것이 없다는 것을 확인할 때. 기다려도 더 오지 않는지 잠깐 지켜본다. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 100); });

async function withBridge(
  runTest: (harness: Harness) => Promise<void>,
  clientOptions: { refusePhotos?: boolean } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-turn-images-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const outgoing: Outgoing[] = [];
  let during: (writer: ProviderRuntimeWriter) => Promise<void> = async () => {};
  const runtime = {
    hasRuntime: () => true,
    run: async (_provider: string, _command: string, _options: unknown, writer: ProviderRuntimeWriter) => {
      await during(writer);
    },
    abort: async () => true,
    resolveToolApproval: () => {},
    getPendingApprovalsForSession: () => [],
  } as never;

  const bridge = startTelegramBridge({
    botToken: 'test-token',
    allowedChatIds: [CHAT_ID],
    runtime,
    client: createFakeClient(outgoing, clientOptions),
  });

  try {
    const user = userDb.createUser('bridge', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'Images Project');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Images session');

    await runTest({
      projectPath: tempDirectory,
      outgoing,
      runTurn: async (nextDuring) => {
        during = nextDuring;
        // 텔레그램에서 시작한 턴이어야 결과가 돌아온다.
        await runDetachedChatTurn(
          { sessionId: SESSION_ID, userId: Number(user.id), content: '그려줘', origin: 'telegram' },
          { runtime, isSessionHandedToTelegram: () => false },
        );
      },
    });
  } finally {
    bridge.stop();
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

function writeToolEvent(filePath: string) {
  return {
    kind: 'tool_use',
    provider: 'claude',
    sessionId: SESSION_ID,
    toolName: 'Write',
    toolInput: { file_path: filePath, content: '' },
  };
}

test('Write 로 만든 이미지는 완료 메시지 뒤에 사진으로 간다', async () => {
  await withBridge(async ({ projectPath, outgoing, runTurn }) => {
    await runTurn(async (writer) => {
      const imagePath = path.join(projectPath, 'chart.png');
      await writeFile(imagePath, PNG_BYTES);
      writer.send(writeToolEvent(imagePath));
    });

    await waitUntil(() => outgoing.length >= 2);
    assert.equal(outgoing[0].kind, 'message');
    assert.deepEqual(outgoing[1], { kind: 'photo', name: 'chart.png', size: PNG_BYTES.length });
  });
});

test('Codex 가 그린 그림(응답에 실린 images)도 간다', async () => {
  await withBridge(async ({ projectPath, outgoing, runTurn }) => {
    await runTurn(async (writer) => {
      const imagePath = path.join(projectPath, 'ig_1.png');
      await writeFile(imagePath, PNG_BYTES);
      writer.send({
        kind: 'text',
        role: 'assistant',
        provider: 'codex',
        sessionId: SESSION_ID,
        content: '',
        images: [{ path: imagePath, name: 'ig_1.png', mimeType: 'image/png' }],
      });
    });

    await waitUntil(() => outgoing.some((item) => item.kind === 'photo'));
    assert.deepEqual(
      outgoing.flatMap((item) => (item.kind === 'photo' ? [item.name] : [])),
      ['ig_1.png'],
    );
  });
});

test('상대 경로는 프로젝트 폴더 기준으로 찾는다', async () => {
  await withBridge(async ({ projectPath, outgoing, runTurn }) => {
    await runTurn(async (writer) => {
      await writeFile(path.join(projectPath, 'relative.png'), PNG_BYTES);
      writer.send(writeToolEvent('relative.png'));
    });

    await waitUntil(() => outgoing.some((item) => item.kind === 'photo'));
    assert.equal(outgoing.some((item) => item.kind === 'photo' && item.name === 'relative.png'), true);
  });
});

test('이미지가 아닌 것, 이름만 이미지인 것, 이 턴 전에 있던 것, 사용자 첨부는 가지 않는다', async () => {
  await withBridge(async ({ projectPath, outgoing, runTurn }) => {
    const oldImage = path.join(projectPath, 'old.png');
    await writeFile(oldImage, PNG_BYTES);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(oldImage, longAgo, longAgo);

    const userImage = path.join(projectPath, 'from-user.png');
    await writeFile(userImage, PNG_BYTES);

    await runTurn(async (writer) => {
      const sourceFile = path.join(projectPath, 'index.ts');
      await writeFile(sourceFile, 'export {};');
      writer.send(writeToolEvent(sourceFile));

      // Write 는 글자만 쓴다. 이름이 .png 여도 내용은 SVG 일 수 있다.
      const fakeImage = path.join(projectPath, 'fake.png');
      await writeFile(fakeImage, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      writer.send(writeToolEvent(fakeImage));

      writer.send(writeToolEvent(oldImage));

      writer.send({
        kind: 'text',
        role: 'user',
        provider: 'claude',
        sessionId: SESSION_ID,
        content: '이거 봐줘',
        images: [{ path: userImage }],
      });
    });

    await waitUntil(() => outgoing.length >= 1);
    await settle();
    assert.deepEqual(outgoing.map((item) => item.kind), ['message']);
  });
});

test('사진으로 거절되면 파일로 다시 보낸다', async () => {
  await withBridge(async ({ projectPath, outgoing, runTurn }) => {
    await runTurn(async (writer) => {
      const imagePath = path.join(projectPath, 'tall-screenshot.png');
      await writeFile(imagePath, PNG_BYTES);
      writer.send(writeToolEvent(imagePath));
    });

    await waitUntil(() => outgoing.some((item) => item.kind === 'document'));
    assert.deepEqual(
      outgoing.filter((item) => item.kind !== 'message'),
      [{ kind: 'document', name: 'tall-screenshot.png', size: PNG_BYTES.length }],
    );
  }, { refusePhotos: true });
});

test('한 턴에 너무 많이 만들면 10장만 보내고 남은 수를 알린다', async () => {
  await withBridge(async ({ projectPath, outgoing, runTurn }) => {
    await runTurn(async (writer) => {
      for (let index = 0; index < 12; index += 1) {
        const imagePath = path.join(projectPath, `frame-${index}.png`);
        await writeFile(imagePath, PNG_BYTES);
        writer.send(writeToolEvent(imagePath));
      }
    });

    await waitUntil(() => outgoing.some((item) => item.kind === 'message' && /2장/.test(item.text)));
    assert.equal(outgoing.filter((item) => item.kind === 'photo').length, 10);
    assert.match((outgoing.at(-1) as { text: string }).text, /이미지 2장은 더 있어/);
  });
});

test('사진은 multipart 로 올리고, 실패 문구에는 토큰이 남지 않는다', async () => {
  const token = '123456:secret-token';
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; form: FormData }> = [];

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    requests.push({ url: String(input), form: init?.body as FormData });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`fetch failed: ${String(input)}`);
  }) as typeof fetch;

  try {
    const client = createTelegramClient(token);
    await client.sendPhoto(CHAT_ID, PNG_BYTES, 'chart.png');

    assert.equal(requests[0].url, `https://api.telegram.org/bot${token}/sendPhoto`);
    assert.equal(requests[0].form.get('chat_id'), String(CHAT_ID));
    const photo = requests[0].form.get('photo') as File;
    assert.equal(photo.name, 'chart.png');
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), PNG_BYTES);

    await assert.rejects(
      client.sendDocument(CHAT_ID, PNG_BYTES, 'chart.png'),
      (error: Error) => !error.message.includes(token) && error.message.includes('***'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
