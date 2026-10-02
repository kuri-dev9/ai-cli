import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { handleTelegramCommand } from '@/modules/telegram-bridge/index.js';
import { startTelegramBridge } from '@/modules/telegram-bridge/services/telegram-bridge.service.js';
import { createTelegramClient } from '@/modules/telegram-bridge/services/telegram-client.service.js';
import type {
  TelegramButton,
  TelegramClient,
  TelegramUpdate,
} from '@/modules/telegram-bridge/services/telegram-client.service.js';
import { handleTelegramButton } from '@/modules/telegram-bridge/services/telegram-commands.service.js';
import type { TelegramReply } from '@/modules/telegram-bridge/services/telegram-commands.service.js';
import { readBridgeState, writeBridgeState } from '@/modules/telegram-bridge/services/telegram-state.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * `/new` 로 텔레그램에서 새 대화를 연다.
 *
 * 텔레그램 메뉴는 명령을 누르는 순간 인자 없이 보낸다. 그래서 `/new` 만 와도
 * 다음 글을 첫 메시지로 받아야 하고, 고를 거리는 버튼으로 내밀어야 한다.
 */

const CHAT_ID = 4242;

type RunCall = { provider: string; command: string; options: Record<string, unknown>; sessionId: string };

type Harness = {
  userId: number;
  projectPath: string;
  runs: RunCall[];
  /** 이 테스트에서 "설치·로그인된" 것으로 칠 AI. 바꿔 가며 쓴다. */
  connected: LLMProvider[];
  send: (text: string) => ReturnType<typeof handleTelegramCommand>;
  press: (data: string) => ReturnType<typeof handleTelegramButton>;
};

function replyText(reply: string | TelegramReply | null): string {
  return typeof reply === 'string' ? reply : reply?.text ?? '';
}

function replyButtons(reply: string | TelegramReply | null): TelegramButton[] {
  return typeof reply === 'object' && reply ? reply.buttons.flat() : [];
}

async function withHarness(
  runTest: (harness: Harness) => Promise<void>,
  options: { runtimeAvailable?: boolean } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'telegram-new-chat-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const runtime = {
    hasRuntime: () => options.runtimeAvailable ?? true,
    run: async (provider: string, command: string, runOptions: Record<string, unknown>) => {
      runs.push({ provider, command, options: runOptions, sessionId: String(runOptions.sessionId) });
    },
    abort: async () => true,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
  } as never;

  try {
    const user = userDb.createUser('new-chat', 'hash');
    projectsDb.createProjectPath(tempDirectory, 'New Chat Project');
    const harness: Harness = {
      userId: Number(user.id),
      projectPath: tempDirectory,
      runs,
      connected: ['claude', 'codex'],
      send: (text) => handleTelegramCommand(text, {
        userId: Number(user.id),
        runtime,
        listConnectedProviders: async () => harness.connected,
      }),
      press: (data) => handleTelegramButton(data, {
        userId: Number(user.id),
        runtime,
        listConnectedProviders: async () => harness.connected,
      }),
    };
    await runTest(harness);
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

test('/new 뒤에 글이 있으면 바로 새 대화를 열고, 기록이 없으면 Claude 로 연다', async () => {
  await withHarness(async ({ userId, projectPath, runs, send }) => {
    const reply = await send('/new 안녕?');

    assert.match(replyText(reply), /새 Claude 대화를 시작/);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].provider, 'claude');
    assert.equal(runs[0].command, '안녕?');
    assert.equal(runs[0].options.model, undefined);

    // 구독이 새 대화로 옮겨 가서, 이어서 보내는 글도 그리로 간다.
    const watched = readBridgeState(userId).watchedSessionId;
    assert.equal(watched, runs[0].sessionId);
    assert.equal(sessionsDb.getSessionById(watched ?? '')?.project_path, projectPath);

    await send('하나 더');
    assert.deepEqual(runs.map((run) => run.sessionId), [watched, watched]);
  });
});

test('새 대화는 구독 중인 곳이 아니라 마지막에 쓴 프로젝트에 들어간다', async () => {
  await withHarness(async ({ projectPath, runs, send }) => {
    const otherProject = path.join(projectPath, 'other');
    projectsDb.createProjectPath(otherProject, 'Other Project');
    sessionsDb.createAppSession('a-watched', 'claude', projectPath, 'watched');
    await send('/watch 1');
    // 구독은 첫 프로젝트에 있지만, 가장 최근에 쓴 대화는 다른 프로젝트에 있다.
    sessionsDb.createAppSession('z-latest', 'claude', otherProject, 'latest');

    await send('/new 안녕');

    assert.equal(sessionsDb.getSessionById(runs[0].sessionId)?.project_path, otherProject);
  });
});

test('여러 줄 메시지는 줄바꿈을 지킨 채로 들어간다', async () => {
  await withHarness(async ({ runs, send }) => {
    await send('/new codex 첫 줄\n둘째 줄');
    assert.equal(runs[0].command, '첫 줄\n둘째 줄');
  });
});

test('AI 를 고르면 그 AI 로, 그 AI 로 마지막에 쓴 모델로 연다', async () => {
  await withHarness(async ({ projectPath, runs, send }) => {
    sessionsDb.createAppSession('old-codex', 'codex', projectPath, 'old');
    sessionsDb.setSessionModel('old-codex', 'gpt-5.5-codex');

    await send('/new codex 버그 찾아줘');

    assert.equal(runs[0].provider, 'codex');
    assert.equal(runs[0].command, '버그 찾아줘');
    assert.equal(runs[0].options.model, 'gpt-5.5-codex');
  });
});

test('AI 를 고르지 않으면 마지막에 쓴 AI 와 모델로 연다', async () => {
  await withHarness(async ({ projectPath, runs, send }) => {
    sessionsDb.createAppSession('a-claude', 'claude', projectPath, 'older');
    sessionsDb.createAppSession('z-codex', 'codex', projectPath, 'latest');
    sessionsDb.setSessionModel('z-codex', 'gpt-5.5');

    await send('/new 이어서 해줘');

    assert.equal(runs[0].provider, 'codex');
    assert.equal(runs[0].options.model, 'gpt-5.5');
  });
});

test('마지막에 쓴 AI 를 지금 쓸 수 없으면 Claude 로 연다', async () => {
  await withHarness(async (harness) => {
    sessionsDb.createAppSession('z-cursor', 'cursor', harness.projectPath, 'latest');

    await harness.send('/new 안녕');

    assert.equal(harness.runs[0].provider, 'claude');
  });
});

test('AI 이름과 정확히 같지 않은 첫 낱말은 메시지의 일부다', async () => {
  await withHarness(async ({ runs, send }) => {
    await send('/new claude가 뭐야?');

    assert.equal(runs[0].provider, 'claude');
    assert.equal(runs[0].command, 'claude가 뭐야?');
  });
});

test('쓸 수 없는 AI 를 고르면 대화를 만들지 않고 쓸 수 있는 것을 알려 준다', async () => {
  await withHarness(async ({ runs, send }) => {
    const before = sessionsDb.getAllSessions().length;
    const reply = await send('/new cursor 안녕');

    assert.match(replyText(reply), /Cursor 는 이 컴퓨터에서 쓸 수 없습니다/);
    assert.match(replyText(reply), /Claude, Codex/);
    assert.equal(runs.length, 0);
    assert.equal(sessionsDb.getAllSessions().length, before);
  });
});

test('메뉴에서 누른 /new 는 다음 글을 첫 메시지로 받는다', async () => {
  await withHarness(async ({ projectPath, runs, send }) => {
    sessionsDb.createAppSession('watched', 'claude', projectPath, 'watched');
    await send('/watch 1');

    const reply = await send('/new');
    assert.match(replyText(reply), /새 Claude 대화를 엽니다. 첫 메시지를 보내 주세요/);
    // 다른 AI 로 바꿀 버튼과 취소 버튼.
    assert.deepEqual(replyButtons(reply).map((button) => button.data), ['new:codex', 'new:cancel']);
    assert.equal(runs.length, 0);

    await send('첫 메시지');

    assert.equal(runs.length, 1);
    assert.notEqual(runs[0].sessionId, 'watched');
    assert.equal(runs[0].command, '첫 메시지');

    // 표시는 한 번 쓰면 사라진다. 다음 글은 새 대화로 이어진다.
    await send('두 번째');
    assert.equal(runs[1].sessionId, runs[0].sessionId);
  });
});

test('AI 만 붙인 /new 는 그 AI 로 첫 메시지를 기다린다', async () => {
  await withHarness(async ({ runs, send }) => {
    const reply = await send('/new codex');

    assert.match(replyText(reply), /새 Codex 대화를 엽니다/);
    assert.deepEqual(replyButtons(reply).map((button) => button.data), ['new:cancel']);

    await send('시작');
    assert.equal(runs[0].provider, 'codex');
  });
});

test('버튼으로 AI 를 바꾸거나 취소할 수 있다', async () => {
  await withHarness(async ({ userId, projectPath, runs, send, press }) => {
    sessionsDb.createAppSession('watched', 'claude', projectPath, 'watched');
    await send('/watch 1');

    await send('/new');
    const switched = await press('new:codex');
    assert.equal(switched.toast, 'Codex');
    assert.equal(readBridgeState(userId).pendingNewChat?.provider, 'codex');

    await send('코덱스로');
    assert.equal(runs[0].provider, 'codex');

    await send('/new');
    const cancelled = await press('new:cancel');
    assert.match(replyText(cancelled.reply), /열지 않습니다/);
    assert.equal(readBridgeState(userId).pendingNewChat, null);
  });
});

test('기다리는 중에 다른 명령을 치면 새 대화는 그만둔 것으로 본다', async () => {
  await withHarness(async ({ projectPath, runs, send }) => {
    sessionsDb.createAppSession('watched', 'claude', projectPath, 'watched');
    await send('/watch 1');

    await send('/new');
    await send('/status');
    await send('원래 대화로');

    assert.equal(runs[0].sessionId, 'watched');
  });
});

test('오래된 /new 는 한참 뒤의 글을 가로채지 않는다', async () => {
  await withHarness(async ({ userId, projectPath, runs, send }) => {
    sessionsDb.createAppSession('watched', 'claude', projectPath, 'watched');
    await send('/watch 1');

    await send('/new');
    const pending = readBridgeState(userId).pendingNewChat;
    assert.ok(pending);
    writeBridgeState(userId, { pendingNewChat: { ...pending, createdAt: Date.now() - 60 * 60 * 1000 } });

    await send('원래 대화로');
    assert.equal(runs[0].sessionId, 'watched');
  });
});

test('첫 메시지가 들어가지 못하면 만든 대화를 지우고 구독을 되돌린다', async () => {
  await withHarness(async ({ userId, projectPath, send }) => {
    sessionsDb.createAppSession('watched', 'claude', projectPath, 'watched');
    await send('/watch 1');
    const before = sessionsDb.getAllSessions().length;

    const reply = await send('/new 안녕');

    assert.match(replyText(reply), /보내지 못했습니다/);
    assert.equal(sessionsDb.getAllSessions().length, before);
    assert.equal(readBridgeState(userId).watchedSessionId, 'watched');
  }, { runtimeAvailable: false });
});

test('인자 없는 /watch 는 프로젝트 버튼을 단다', async () => {
  await withHarness(async ({ userId, projectPath, send, press }) => {
    sessionsDb.createAppSession('watched', 'claude', projectPath, 'watched');

    const reply = await send('/watch');
    const [button] = replyButtons(reply);
    assert.match(button.text, /New Chat Project/);
    assert.match(button.data, /^watch:/);

    const result = await press(button.data);
    assert.match(replyText(result.reply), /최신 대화를 구독한다/);
    assert.equal(readBridgeState(userId).watchedSessionId, 'watched');
  });
});

test('모르는 버튼은 아무것도 하지 않는다', async () => {
  await withHarness(async ({ press }) => {
    const result = await press('nope:1');
    assert.equal(result.reply, null);
  });
});

// ── 브리지 ────────────────────────────────────────────────

test('버튼을 누르면 답하고, 버튼을 걷어 내고, 결과를 보낸다', async () => {
  await withHarness(async ({ userId }) => {
    const calls: string[] = [];
    const queue: TelegramUpdate[][] = [[{
      updateId: 1,
      message: null,
      buttonPress: { queryId: 'q1', chatId: CHAT_ID, messageId: 77, data: 'new:cancel' },
    }]];

    const client = {
      getUpdates: (_offset: number, signal?: AbortSignal) => {
        const next = queue.shift();
        if (next) {
          return Promise.resolve(next);
        }
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
      sendMessage: async (_chatId: number, text: string) => { calls.push(`send:${text}`); },
      answerButtonPress: async (queryId: string, toast?: string) => { calls.push(`answer:${queryId}:${toast}`); },
      clearButtons: async (_chatId: number, messageId: number) => { calls.push(`clear:${messageId}`); },
      requestTimeoutMs: 1_000,
    } as unknown as TelegramClient;

    writeBridgeState(userId, {
      pendingNewChat: { provider: 'claude', model: null, createdAt: Date.now() },
    });

    const bridge = startTelegramBridge({
      botToken: 'test-token',
      allowedChatIds: [CHAT_ID],
      runtime: {} as never,
      client,
    });

    const deadline = Date.now() + 2_000;
    while (calls.length < 3 && Date.now() < deadline) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    bridge.stop();

    assert.deepEqual(calls, ['answer:q1:취소', 'clear:77', 'send:새 대화를 열지 않습니다.']);
    assert.equal(readBridgeState(userId).pendingNewChat, null);
  });
});

test('클라이언트는 버튼 누름을 받아 오고, 버튼을 단 메시지를 보낸다', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (String(input).endsWith('/getUpdates')) {
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 5,
          callback_query: { id: 'q9', data: 'new:codex', message: { message_id: 12, chat: { id: CHAT_ID } } },
        }],
      }));
    }
    return new Response(JSON.stringify({ ok: true, result: true }));
  }) as typeof fetch;

  try {
    const client = createTelegramClient('123:token');
    const [update] = await client.getUpdates(0);
    assert.deepEqual(update.buttonPress, { queryId: 'q9', chatId: CHAT_ID, messageId: 12, data: 'new:codex' });
    assert.deepEqual(bodies[0].allowed_updates, ['message', 'callback_query']);

    await client.sendMessage(CHAT_ID, '고르세요', [[{ text: 'Codex', data: 'new:codex' }]]);
    assert.deepEqual(bodies[1].reply_markup, {
      inline_keyboard: [[{ text: 'Codex', callback_data: 'new:codex' }]],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
