import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

const readTomlConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = TOML.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const writeTomlConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const toml = TOML.stringify(data as never);
  await writeFile(filePath, toml, 'utf8');
};

const userConfigPath = (): string => path.join(os.homedir(), '.codex', 'config.toml');

/**
 * 홈 디렉터리 자체가 프로젝트로 등록돼 있으면 project 스코프 경로가
 * ~/.codex/config.toml 로 user 스코프와 겹친다. 같은 파일을 두 스코프로
 * 읽으면 목록에 모든 서버가 두 번 보이므로, 이 경우 project 스코프는 없는 것으로 본다.
 */
const resolveCodexConfigPath = (scope: McpScope, workspacePath: string): string | null => {
  if (scope === 'user') {
    return userConfigPath();
  }
  const projectPath = path.join(workspacePath, '.codex', 'config.toml');
  return path.resolve(projectPath) === path.resolve(userConfigPath()) ? null : projectPath;
};

export class CodexMcpProvider extends McpProvider {
  constructor() {
    super('codex', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const filePath = resolveCodexConfigPath(scope, workspacePath);
    if (!filePath) {
      return {};
    }
    const config = await readTomlConfig(filePath);
    return readObjectRecord(config.mcp_servers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = resolveCodexConfigPath(scope, workspacePath);
    if (!filePath) {
      throw new AppError('Project-scoped MCP config for the home directory is the user config; use the user scope instead.', {
        code: 'MCP_PROJECT_SCOPE_IS_USER_CONFIG',
        statusCode: 400,
      });
    }
    const config = await readTomlConfig(filePath);
    config.mcp_servers = servers;
    await writeTomlConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        env_vars: input.envVars ?? [],
        cwd: input.cwd,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url: input.url,
      bearer_token_env_var: input.bearerTokenEnvVar,
      http_headers: input.headers ?? {},
      env_http_headers: input.envHttpHeaders ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'codex',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
        envVars: readStringArray(config.env_vars),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'codex',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.http_headers),
        bearerTokenEnvVar: readOptionalString(config.bearer_token_env_var),
        envHttpHeaders: readStringRecord(config.env_http_headers),
      };
    }

    return null;
  }
}
