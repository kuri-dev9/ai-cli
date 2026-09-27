/**
 * Claude 구독 한도를 계정에 직접 물어본다.
 *
 * SDK 가 흘려주는 `rate_limit_event` 만으로는 화면을 채울 수 없다. 그 이벤트는
 * 한도가 바뀔 때만, 그 순간 걸리는 창 하나만 보내고,
 * `utilization`·`rateLimitType`·`resetsAt` 이 모두 선택 필드라 사용률 없이 오기도
 * 한다. 실제로 "보고되지 않음" 으로만 남는 계정이 있다.
 *
 * Claude Code 가 `/usage` 를 그릴 때 쓰는 엔드포인트를 같은 자격증명으로 부르면
 * 모든 창이 사용률과 함께 한 번에 온다. 문서화된 API 가 아니므로 실패는 모두
 * 빈 결과로 떨어뜨리고, 호출한 쪽이 쌓아 둔 이벤트로 물러설 수 있게 한다.
 */

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

import type { ProviderRateLimitWindow } from '@/shared/types.js';
import { getClaudeHomeDirectory } from '@/shared/utils.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/** 새로고침 연타가 그대로 요청이 되지 않을 만큼만. */
const CACHE_TTL_MS = 30_000;

const REQUEST_TIMEOUT_MS = 10_000;

/** Claude Code 가 자격증명을 넣어 두는 macOS 키체인 항목. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * `limits[].kind` → 창 이름. Claude 가 이벤트로 보내던 이름에 맞춰 둔다. 같은
 * 이름을 쓰면 화면이 프로바이더별로 라벨을 따로 들고 있지 않아도 된다.
 */
const WINDOW_NAMES_BY_KIND: Record<string, string> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
};

/** `severity` → 이벤트 쪽 status 어휘. 모르는 값은 사용률로 판단한다. */
const STATUS_BY_SEVERITY: Record<string, ProviderRateLimitWindow['status']> = {
  normal: 'allowed',
  warning: 'allowed_warning',
  critical: 'allowed_warning',
  blocked: 'rejected',
};

export type ClaudeUsageSnapshot = {
  windows: ProviderRateLimitWindow[];
  planType?: string;
};

type ClaudeCredentials = {
  accessToken: string;
  subscriptionType?: string;
};

type ClaudeUsageServiceDependencies = {
  readCredentials: () => Promise<ClaudeCredentials | null>;
  fetchUsage: (credentials: ClaudeCredentials) => Promise<unknown>;
  now: () => number;
};

const readOptionalString = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

/** 응답의 `percent` 는 0..100 이고 화면은 0..1 을 읽는다. */
const readUtilization = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  // 넘긴 경우 막대가 사라지는 대신 가득 찬 것으로 읽히게 잘라 둔다.
  return Math.min(parsed, 100) / 100;
};

const readResetsAt = (value: unknown): string | null => {
  const raw = readOptionalString(value);
  if (!raw) {
    return null;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * 모델별 주간 창의 이름. `scope.model.display_name` 이 `Fable` 이면
 * `seven_day_fable` — 이벤트가 보내던 이름과 같아서 라벨이 그대로 붙는다.
 */
const scopedWindowName = (scope: unknown): string | null => {
  if (!scope || typeof scope !== 'object') {
    return null;
  }
  const model = (scope as Record<string, unknown>).model as Record<string, unknown> | undefined;
  const displayName = readOptionalString(model?.display_name);
  if (!displayName) {
    return null;
  }
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
};

const toWindow = (raw: unknown, observedAt: string): ProviderRateLimitWindow | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const limit = raw as Record<string, unknown>;
  const kind = readOptionalString(limit.kind);
  if (!kind) {
    return null;
  }

  const utilization = readUtilization(limit.percent);
  const severity = readOptionalString(limit.severity);
  const status = STATUS_BY_SEVERITY[severity]
    // 모르는 severity 는 사용률로 판단한다. 다 쓴 창을 정상으로 그리지 않기 위해서다.
    ?? (utilization !== null && utilization >= 1 ? 'rejected' : 'allowed');

  return {
    type: WINDOW_NAMES_BY_KIND[kind]
      ?? (kind === 'weekly_scoped' ? scopedWindowName(limit.scope) ?? kind : kind),
    status,
    utilization,
    resetsAt: readResetsAt(limit.resets_at),
    observedAt,
  };
};

/**
 * 자격증명은 파일에 있을 수도, 키체인에 있을 수도 있다. Claude Code 가 보는
 * 순서를 그대로 따른다 — 파일이 있으면 그것이 최신이다.
 */
const defaultReadCredentials = async (): Promise<ClaudeCredentials | null> => {
  const fromOauth = (raw: unknown): ClaudeCredentials | null => {
    const oauth = (raw as Record<string, unknown> | null)?.claudeAiOauth as
      | Record<string, unknown>
      | undefined;
    const accessToken = readOptionalString(oauth?.accessToken);
    if (!accessToken) {
      return null;
    }
    return {
      accessToken,
      subscriptionType: readOptionalString(oauth?.subscriptionType) || undefined,
    };
  };

  try {
    const filePath = path.join(getClaudeHomeDirectory(), '.credentials.json');
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
    const credentials = fromOauth(parsed);
    if (credentials) {
      return credentials;
    }
  } catch {
    // 파일이 없는 설치가 정상이다 — macOS 는 키체인에 넣는다.
  }

  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS },
    );
    return fromOauth(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
};

const defaultFetchUsage = (credentials: ClaudeCredentials): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const target = new URL(USAGE_ENDPOINT);
    const request = https.request(
      {
        hostname: target.hostname,
        path: target.pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          // OAuth 토큰으로 부르는 경로라 이 베타 플래그가 필요하다.
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
          'User-Agent': 'claude-cli (external, cli)',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new Error(`Claude usage request failed with ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Claude usage response was not JSON'));
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Claude usage request timed out'));
    });
    request.on('error', reject);
    request.end();
  });

export function createClaudeUsageService(
  dependencies: Partial<ClaudeUsageServiceDependencies> = {},
) {
  const {
    readCredentials = defaultReadCredentials,
    fetchUsage = defaultFetchUsage,
    now = () => Date.now(),
  } = dependencies;

  let cached: { at: number; snapshot: ClaudeUsageSnapshot } | null = null;

  return {
    /** 창을 하나도 못 읽으면 빈 목록. 부른 쪽이 쌓아 둔 이벤트로 물러설 수 있다. */
    async getSnapshot(): Promise<ClaudeUsageSnapshot> {
      if (cached && now() - cached.at < CACHE_TTL_MS) {
        return cached.snapshot;
      }

      const credentials = await readCredentials();
      if (!credentials) {
        // 로그인하지 않은 상태와 실패를 구분하지 않는다. 물러설 곳이 같다.
        return { windows: [] };
      }

      let usage: unknown;
      try {
        usage = await fetchUsage(credentials);
      } catch (error) {
        console.warn('[Claude usage] Failed to read usage:', error);
        return { windows: [] };
      }

      const payload = (usage ?? {}) as Record<string, unknown>;
      const observedAt = new Date(now()).toISOString();
      const limits = Array.isArray(payload.limits) ? payload.limits : [];

      const windows = limits
        .map((limit) => toWindow(limit, observedAt))
        .filter((window): window is ProviderRateLimitWindow => window !== null);

      // 초과 사용은 켜 둔 계정에서만 창이 된다. 꺼져 있으면 0% 막대만 남는다.
      const extraUsage = payload.extra_usage as Record<string, unknown> | undefined;
      if (extraUsage?.is_enabled === true) {
        windows.push({
          type: 'overage',
          status: extraUsage.spend_limit_reached === true ? 'rejected' : 'allowed',
          utilization: readUtilization(extraUsage.utilization),
          resetsAt: null,
          observedAt,
        });
      }

      const snapshot: ClaudeUsageSnapshot = {
        windows,
        planType: credentials.subscriptionType,
      };
      cached = { at: now(), snapshot };
      return snapshot;
    },

    /** 테스트와, 로그인 직후처럼 캐시가 거짓이 되는 순간을 위해. */
    clearCache(): void {
      cached = null;
    },
  };
}

export const claudeUsageService = createClaudeUsageService();
