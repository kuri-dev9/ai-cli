import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { mcpConnectionTestService } from '@/modules/providers/services/mcp-connection-test.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { AppError } from '@/shared/utils.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

/**
 * This test covers Claude MCP support for all scopes (user/local/project) and all transports (stdio/http/sse),
 * including add, update/list, and remove operations.
 */
test('providerMcpService handles claude MCP scopes/transports with file-backed persistence', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-server'],
      env: { API_KEY: 'secret' },
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-API-Key': 'abc' },
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('claude', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'claude-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.local.some((server) => server.name === 'claude-local-http' && server.transport === 'http'));
    assert.ok(grouped.project.some((server) => server.name === 'claude-project-sse' && server.transport === 'sse'));

    // update behavior is the same upsert route with same name
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse-updated',
      headers: { 'X-API-Key': 'updated' },
      workspacePath,
    });

    const projectConfig = await readJson(path.join(workspacePath, '.mcp.json'));
    const projectServers = projectConfig.mcpServers as Record<string, unknown>;
    const projectServer = projectServers['claude-project-sse'] as Record<string, unknown>;
    assert.equal(projectServer.url, 'https://example.com/sse-updated');

    const removeResult = await providerMcpService.removeProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      workspacePath,
    });
    assert.equal(removeResult.removed, true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Codex MCP support for user/project scopes, stdio/http formats,
 * and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles codex MCP TOML config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-codex-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'python',
      args: ['server.py'],
      env: { API_KEY: 'x' },
      envVars: ['API_KEY'],
      cwd: '/tmp',
    });

    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://codex.example.com/mcp',
      headers: { 'X-Custom-Header': 'value' },
      envHttpHeaders: { 'X-API-Key': 'MY_API_KEY_ENV' },
      bearerTokenEnvVar: 'MY_API_TOKEN',
      workspacePath,
    });

    const userTomlPath = path.join(tempRoot, '.codex', 'config.toml');
    const userConfig = TOML.parse(await fs.readFile(userTomlPath, 'utf8')) as Record<string, unknown>;
    const userServers = userConfig.mcp_servers as Record<string, unknown>;
    const userStdio = userServers['codex-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.command, 'python');

    const projectTomlPath = path.join(workspacePath, '.codex', 'config.toml');
    const projectConfig = TOML.parse(await fs.readFile(projectTomlPath, 'utf8')) as Record<string, unknown>;
    const projectServers = projectConfig.mcp_servers as Record<string, unknown>;
    const projectHttp = projectServers['codex-project-http'] as Record<string, unknown>;
    assert.equal(projectHttp.url, 'https://codex.example.com/mcp');

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers OpenCode MCP support for user/project config files, JSONC-compatible
 * reads, and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles opencode MCP config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-opencode-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(tempRoot, '.config', 'opencode'), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, '.config', 'opencode', 'opencode.jsonc'),
    `{
      // Existing comments should not block OpenCode MCP reads.
      "mcp": {}
    }\n`,
    'utf8',
  );

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'opencode-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'x' },
    });

    await providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'opencode-project-http',
      scope: 'project',
      transport: 'http',
      url: 'https://opencode.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    const userConfig = await readJson(path.join(tempRoot, '.config', 'opencode', 'opencode.jsonc'));
    const userServers = userConfig.mcp as Record<string, unknown>;
    const userStdio = userServers['opencode-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.type, 'local');
    assert.deepEqual(userStdio.command, ['node', 'server.js']);
    assert.deepEqual(userStdio.environment, { API_KEY: 'x' });

    const projectConfig = await readJson(path.join(workspacePath, 'opencode.json'));
    const projectServers = projectConfig.mcp as Record<string, unknown>;
    const projectHttp = projectServers['opencode-project-http'] as Record<string, unknown>;
    assert.equal(projectHttp.type, 'remote');
    assert.equal(projectHttp.url, 'https://opencode.example.com/mcp');

    const grouped = await providerMcpService.listProviderMcpServers('opencode', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'opencode-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.project.some((server) => server.name === 'opencode-project-http' && server.transport === 'http'));

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('opencode', {
        name: 'opencode-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('opencode', {
        name: 'opencode-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Cursor MCP JSON format and user/project scope persistence.
 */
test('providerMcpService handles cursor MCP JSON config formats', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-gc-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-stdio',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server'],
      env: { API_KEY: 'value' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-http',
      scope: 'user',
      transport: 'http',
      url: 'http://localhost:3333/mcp',
      headers: { API_KEY: 'value' },
    });

    const cursorUserConfig = await readJson(path.join(tempRoot, '.cursor', 'mcp.json'));
    const cursorHttpServer = (cursorUserConfig.mcpServers as Record<string, unknown>)['cursor-http'] as Record<string, unknown>;
    assert.equal(cursorHttpServer.url, 'http://localhost:3333/mcp');
    assert.equal(cursorHttpServer.type, undefined);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers the global MCP adder requirement: only http/stdio are allowed and
 * one payload is written to all providers.
 */
test('providerMcpService global adder writes to all providers and rejects unsupported transports', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-global-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const globalResult = await providerMcpService.addMcpServerToAllProviders({
      name: 'global-http',
      scope: 'project',
      transport: 'http',
      url: 'https://global.example.com/mcp',
      workspacePath,
    });

    assert.equal(globalResult.length, 4);
    assert.ok(globalResult.every((entry) => entry.created === true));

    const claudeProject = await readJson(path.join(workspacePath, '.mcp.json'));
    assert.ok((claudeProject.mcpServers as Record<string, unknown>)['global-http']);

    const codexProject = TOML.parse(await fs.readFile(path.join(workspacePath, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    assert.ok((codexProject.mcp_servers as Record<string, unknown>)['global-http']);

    const opencodeProject = await readJson(path.join(workspacePath, 'opencode.json'));
    assert.ok((opencodeProject.mcp as Record<string, unknown>)['global-http']);

    const cursorProject = await readJson(path.join(workspacePath, '.cursor', 'mcp.json'));
    assert.ok((cursorProject.mcpServers as Record<string, unknown>)['global-http']);

    await assert.rejects(
      providerMcpService.addMcpServerToAllProviders({
        name: 'global-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_GLOBAL_MCP_TRANSPORT' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});


const stubFetch = (handler: (url: string, init: RequestInit) => Promise<Response> | Response) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => (
    handler(String(input), init)
  )) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
};

const jsonResponse = (status: number, body: unknown): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
);

/**
 * The connection test exists to name the real cause of a failed MCP setup, so
 * these cases pin the status-to-reason mapping the settings form relies on —
 * especially 401, which previously surfaced as an unrelated OAuth/Dynamic
 * Client Registration error.
 */
test('mcpConnectionTestService reports the MCP handshake outcome', { concurrency: false }, async (t) => {
  await t.test('returns serverInfo and forwards the caller headers on success', async () => {
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const restoreFetch = stubFetch((_url, init) => {
      seenHeaders = init.headers as Record<string, string>;
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'queryforge', version: '0.1.0' } },
      });
    });

    try {
      const result = await mcpConnectionTestService.testConnection({
        transport: 'http',
        url: 'http://127.0.0.1:31571/mcp',
        headers: { 'x-api-key': 'secret', 'Content-Type': 'text/plain' },
      });

      assert.deepEqual(result, { ok: true, serverInfo: { name: 'queryforge', version: '0.1.0' } });
      assert.equal(seenHeaders['x-api-key'], 'secret');
      // Our own Content-Type must survive a same-named user header.
      assert.equal(seenHeaders['Content-Type'], 'application/json');
      assert.equal(seenHeaders['Accept'], 'application/json, text/event-stream');
      assert.equal(seenBody.method, 'initialize');
    } finally {
      restoreFetch();
    }
  });

  await t.test('unwraps a streamable HTTP SSE frame', async () => {
    const restoreFetch = stubFetch(() => new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"queryforge"}}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ));

    try {
      const result = await mcpConnectionTestService.testConnection({
        transport: 'http',
        url: 'http://127.0.0.1:31571/mcp',
      });
      assert.deepEqual(result, { ok: true, serverInfo: { name: 'queryforge', version: undefined } });
    } finally {
      restoreFetch();
    }
  });

  await t.test('maps 401 to authFailed rather than a transport error', async () => {
    const restoreFetch = stubFetch(() => new Response('Unauthorized', { status: 401 }));
    try {
      assert.deepEqual(
        await mcpConnectionTestService.testConnection({ transport: 'http', url: 'http://127.0.0.1:31571/mcp' }),
        { ok: false, reason: 'authFailed', status: 401 },
      );
    } finally {
      restoreFetch();
    }
  });

  await t.test('maps 404 to notFound', async () => {
    const restoreFetch = stubFetch(() => new Response('Not Found', { status: 404 }));
    try {
      assert.deepEqual(
        await mcpConnectionTestService.testConnection({ transport: 'http', url: 'http://127.0.0.1:31571/wrong' }),
        { ok: false, reason: 'notFound', status: 404 },
      );
    } finally {
      restoreFetch();
    }
  });

  await t.test('maps a refused socket to unreachable', async () => {
    const restoreFetch = stubFetch(() => {
      const error = new TypeError('fetch failed');
      (error as Error & { cause?: unknown }).cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      });
      throw error;
    });

    try {
      assert.deepEqual(
        await mcpConnectionTestService.testConnection({ transport: 'http', url: 'http://127.0.0.1:9/mcp' }),
        { ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' },
      );
    } finally {
      restoreFetch();
    }
  });

  await t.test('maps a silent server to timeout', async () => {
    const restoreFetch = stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    }));

    try {
      assert.deepEqual(
        await mcpConnectionTestService.testConnection(
          { transport: 'http', url: 'http://127.0.0.1:31571/mcp' },
          { timeoutMs: 20 },
        ),
        { ok: false, reason: 'timeout' },
      );
    } finally {
      restoreFetch();
    }
  });

  await t.test('does not follow a redirect that would leak the auth header', async () => {
    const restoreFetch = stubFetch((_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/mcp' } });
    });

    try {
      assert.deepEqual(
        await mcpConnectionTestService.testConnection({
          transport: 'http',
          url: 'http://127.0.0.1:31571/mcp',
          headers: { 'x-api-key': 'secret' },
        }),
        { ok: false, reason: 'protocolError', status: 302, detail: 'redirect' },
      );
    } finally {
      restoreFetch();
    }
  });

  await t.test('rejects stdio and non-HTTP URLs', async () => {
    await assert.rejects(
      mcpConnectionTestService.testConnection({ transport: 'stdio', url: '' }),
      (error: unknown) => error instanceof AppError && error.code === 'MCP_TEST_UNSUPPORTED_TRANSPORT',
    );

    await assert.rejects(
      mcpConnectionTestService.testConnection({ transport: 'http', url: 'file:///etc/passwd' }),
      (error: unknown) => error instanceof AppError && error.code === 'MCP_TEST_INVALID_URL_PROTOCOL',
    );
  });
});
