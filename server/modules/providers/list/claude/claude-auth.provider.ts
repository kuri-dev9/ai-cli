import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

export class ClaudeProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Claude Code CLI is available on this host.
   */
  private checkInstalled(): boolean {
    // cross-spawn resolves shims and PATHEXT itself, so the bare command is a
    // usable fallback here even where the SDK's raw spawn could not use it.
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    try {
      spawn.sync(cliPath, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `claude auth status` 로 CLI 에게 직접 인증 상태를 묻는다.
   *
   * CLI 가 자기 자격증명을 어디에 두든(환경변수, 파일, macOS 키체인) 정확한 답을
   * 주고, 이메일과 인증 방식까지 함께 알려준다. 토큰 값은 출력하지 않는다.
   *
   * 실패하거나 형식이 예상과 다르면 null 을 돌려주고 아래의 기존 경로로 넘어간다.
   */
  private checkCliAuthStatus(): ClaudeCredentialsStatus | null {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';

    try {
      const result = spawn.sync(cliPath, ['auth', 'status'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      if (result.status !== 0 || typeof result.stdout !== 'string') {
        return null;
      }

      const parsed = readObjectRecord(JSON.parse(result.stdout));
      if (!parsed || parsed.loggedIn !== true) {
        return null;
      }

      return {
        authenticated: true,
        email: readOptionalString(parsed.email) ?? 'Authenticated',
        method: readOptionalString(parsed.authMethod) ?? 'cli',
      };
    } catch {
      return null;
    }
  }

  /**
   * Claude Code가 macOS 키체인에 자격증명을 저장했는지 확인한다.
   *
   * 일부러 `-w`를 붙이지 않는다. 그래서 비밀 값 자체는 절대 읽지 않고
   * 항목의 존재 여부만 본다. 값을 읽으려 할 때 뜨는 키체인 접근 승인
   * 팝업도 이 덕분에 뜨지 않는다.
   *
   * 만료 여부는 여기서 판정하지 않는다. 토큰 갱신은 CLI가 알아서 하므로
   * 항목이 있으면 로그인된 것으로 본다.
   */
  private hasKeychainCredentials(): boolean {
    if (process.platform !== 'darwin') {
      return false;
    }

    try {
      const result = spawn.sync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        { stdio: 'ignore', timeout: 5000 },
      );
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const fileCredentials = await this.checkCredentials();

    // 환경변수와 settings.json, .credentials.json 파일에서 못 찾은 경우를 처리한다.
    // Claude Code 는 macOS 에서 자격증명을 키체인에 넣는데 위 경로들은 그걸 보지
    // 못해서, 멀쩡히 로그인된 상태인데도 미인증으로 표시되는 문제가 있었다.
    //
    // 1순위는 CLI 에게 직접 묻는 것이다. 자격증명을 어디에 뒀든 정확하고 이메일까지
    // 알려준다. CLI 호출이 실패할 때를 대비해 키체인 항목 존재 확인을 남겨둔다.
    const credentials = fileCredentials.authenticated
      ? fileCredentials
      : this.checkCliAuthStatus()
        ?? (this.hasKeychainCredentials()
          ? { authenticated: true, email: 'macOS Keychain', method: 'keychain' }
          : fileCredentials);

    return {
      installed,
      provider: 'claude',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const missingCredentialsError = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'Auth Token', method: 'api_key' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv();
    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { authenticated: true, email: 'Configured via settings.json', method: 'api_key' };
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    try {
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        // `accessToken` is short-lived (hours). Claude Code renews it silently
        // from `refreshToken` on the next CLI invocation, so an expired access
        // token alongside a live refresh token is still a working login. Before
        // this check, a still-signed-in account read as "login has expired"
        // until something else happened to run the CLI — which is why opening
        // the Shell tab and coming back made Settings flip to Connected.
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const refreshTokenExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        if (refreshToken && (!refreshTokenExpiresAt || Date.now() < refreshTokenExpiresAt)) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: missingCredentialsError,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (hasErrorCode(error, 'ENOENT')) {
        errorMessage = missingCredentialsError;
      } else if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }
}
