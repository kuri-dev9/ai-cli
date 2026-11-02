import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { splitScheduleSpec } from '@/shared/schedule-time.js';

import { createCommandsRouter } from '../commands.routes.js';

// `/예약` 이 건 예약. 실제 저장소 대신 여기 쌓는다.
const scheduled: Array<{ userId: number; sessionId: string; content: string; scheduledFor: string }> = [];

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

function createRouter(sessionModels: Record<string, string> = {}) {
  return createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
    scheduler: {
      schedule: (input) => {
        scheduled.push(input);
        return { id: `s-${scheduled.length}`, scheduledFor: input.scheduledFor, content: input.content };
      },
      splitScheduleSpec,
    },
  });
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const router = createRouter(sessionModels);
  const app = express()
    .use(express.json())
    // 실제 서버에서는 인증 미들웨어가 붙인다.
    .use((req, _res, next) => {
      (req as express.Request & { user?: { id: number } }).user = { id: 7 };
      next();
    })
    .use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('/예약 은 AI 를 거치지 않고 지금 대화에 예약을 건다', async () => {
  scheduled.length = 0;
  const before = Date.now();
  const result = await executeCommandWithArgs('/예약', ['+1분', '테스트', '한번', '찍어줘'], { sessionId: 'session-1' });

  const data = result.data as { error?: boolean; message: string };
  assert.equal(data.error, undefined);
  assert.match(data.message, /⏰ 예약됨: .* → 테스트 한번 찍어줘/);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].userId, 7);
  assert.equal(scheduled[0].sessionId, 'session-1');
  assert.equal(scheduled[0].content, '테스트 한번 찍어줘');
  const dueIn = new Date(scheduled[0].scheduledFor).getTime() - before;
  assert.ok(dueIn >= 59_000 && dueIn <= 61_000);
});

test('/예약 은 시각이나 할 일이 없거나 대화가 없으면 이유를 말하고 걸지 않는다', async () => {
  scheduled.length = 0;
  const noTime = await executeCommandWithArgs('/예약', ['언젠가', '해줘'], { sessionId: 'session-1' });
  const noTask = await executeCommandWithArgs('/예약', ['14:50'], { sessionId: 'session-1' });
  const noSession = await executeCommandWithArgs('/schedule', ['+5m', 'test'], {});

  assert.match((noTime.data as { message: string }).message, /시각을 읽지 못했습니다/);
  assert.match((noTask.data as { message: string }).message, /무엇을 할지/);
  assert.match((noSession.data as { message: string }).message, /대화가 시작되지 않았습니다/);
  assert.equal(scheduled.length, 0);
});

async function executeCommandWithArgs(
  commandName: string,
  args: string[],
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const router = createRouter();
  const app = express()
    .use(express.json())
    .use((req, _res, next) => {
      (req as express.Request & { user?: { id: number } }).user = { id: 7 };
      next();
    })
    .use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, args, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
