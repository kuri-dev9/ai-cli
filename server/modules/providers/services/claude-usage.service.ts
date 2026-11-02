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
 * 빈 결과로 떨어뜨린다 — 그때는 1토큰짜리 요청의 응답 헤더에서 한도를 읽고,
 * 그것도 안 되면 CLI 에게 직접 `/usage` 를 물어보고
 * (`claude-cli-usage.service`), 그마저 비면 호출한 쪽이 쌓아 둔 이벤트로 물러선다.
 */

import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

import { claudeCliUsageService } from '@/modules/providers/services/claude-cli-usage.service.js';
import type { ProviderRateLimitWindow } from '@/shared/types.js';
import {
  buildScopedWeeklyWindowName,
  getClaudeHomeDirectory,
  getClaudeKeychainServiceName,
} from '@/shared/utils.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

const MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** 헤더만 읽으면 되는 요청이라 가장 싼 모델에 1토큰만 시킨다. */
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

/** 새로고침 연타가 그대로 요청이 되지 않을 만큼만. */
const CACHE_TTL_MS = 30_000;

const REQUEST_TIMEOUT_MS = 10_000;

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
  /**
   * 어느 길로 읽었는지. `live` 는 계정에 직접(또는 응답 헤더로) 지금 읽은 값,
   * `cli` 는 `claude -p "/usage"`.
   */
  source?: 'live' | 'cli';
};

type ClaudeCredentials = {
  accessToken: string;
  subscriptionType?: string;
};

type ClaudeUsageServiceDependencies = {
  readCredentials: (configDir?: string | null) => Promise<ClaudeCredentials | null>;
  fetchUsage: (credentials: ClaudeCredentials) => Promise<unknown>;
  /** 계정 조회가 막혔을 때, 1토큰 요청의 응답 헤더에서 창들을 읽는 길. */
  probeUsage: (credentials: ClaudeCredentials, observedAt: string) => Promise<ProviderRateLimitWindow[]>;
  /**
   * 직접 물어보기가 실패했을 때 CLI 에게 묻는 길. CLI 는 이 프로세스의
   * `CLAUDE_CONFIG_DIR` 하나만 보므로, 서버 기본 계정을 물을 때만 쓴다 — 다른
   * 등록 계정을 물을 때 불렀다간 기본 계정의 값을 그 계정 것인 양 보여주게 된다.
   */
  readCliUsage: () => Promise<{ windows: ProviderRateLimitWindow[] }>;
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
  return buildScopedWeeklyWindowName(displayName);
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
 * 자격증명은 파일에 있을 수도, 키체인에 있을 수도, 환경변수에 있을 수도 있다.
 * 파일 → 키체인 순서는 Claude Code 를 따른다 — 파일이 있으면 그것이 최신이다.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` 은 Claude Code 에서는 가장 먼저 보지만 여기서는
 * 마지막이다. `claude setup-token` 으로 만든 이 토큰은 사용량 엔드포인트가
 * 받아 주지 않아서(429 와 한 시간짜리 retry-after), 대화형 로그인 토큰이 함께
 * 있으면 그쪽이 낫다. 대화형으로 로그인한 적 없이 이 토큰만으로 돌리는 설치에서는
 * 이것이 유일한 자격증명이고, 계정 조회가 막혀도 헤더로 읽는 길에 쓸 수 있다.
 */
const defaultReadCredentials = async (configDir?: string | null): Promise<ClaudeCredentials | null> => {
  const override = configDir ?? undefined;
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
    const filePath = path.join(getClaudeHomeDirectory(undefined, override), '.credentials.json');
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as unknown;
    const credentials = fromOauth(parsed);
    if (credentials) {
      return credentials;
    }
  } catch {
    // 파일이 없는 설치가 정상이다 — macOS 는 키체인에 넣는다.
  }

  if (process.platform === 'darwin') {
    try {
      // `CLAUDE_CONFIG_DIR` 를 쓰는 설치는 항목 이름 끝에 디렉터리 해시가 붙는다.
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', getClaudeKeychainServiceName(undefined, override), '-w'],
        { encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS },
      );
      const credentials = fromOauth(JSON.parse(raw) as unknown);
      if (credentials) {
        return credentials;
      }
    } catch {
      // 키체인 항목이 없거나 비어 있다. 환경변수 토큰만 쓰는 설치가 이렇다.
    }
  }

  // 이 토큰은 설정 디렉터리에 묶여 있지 않다 — 파일·키체인에 못 찾은 계정의
  // 마지막 수단이다. 여러 계정이 전부 이 길로 떨어지면 전부 같은 토큰을 쓰는
  // 셈이라 구분이 안 되지만, 로그인한 적 없이 setup-token 하나만 돌리는
  // 설치가 대개 하나뿐이라 실제로는 맞는다.
  const envToken = readOptionalString(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  return envToken ? { accessToken: envToken } : null;
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

/**
 * 헤더의 창 이름(`5h`, `7d`, `7d_opus`…)을 이벤트가 쓰던 이름으로 옮긴다.
 * 모르는 접두는 그대로 둔다 — 떨구는 것보다 낯선 라벨이 낫다.
 */
const windowNameFromClaim = (claim: string): string => {
  if (claim === '5h') {
    return 'five_hour';
  }
  if (claim === '7d') {
    return 'seven_day';
  }
  if (claim.startsWith('7d_')) {
    return `seven_day_${claim.slice(3)}`;
  }
  return claim;
};

const readHeaderStatus = (value: unknown): ProviderRateLimitWindow['status'] => {
  const raw = readOptionalString(value);
  return raw === 'allowed' || raw === 'allowed_warning' || raw === 'rejected' ? raw : null;
};

/**
 * `anthropic-ratelimit-unified-<창>-utilization|status|reset` 헤더에서 창들을 만든다.
 * 이 파일의 헤더 확인 요청이 쓰고, 헤더 해석만 따로 확인하려고 테스트
 * (`claude-usage.service.test.ts`)가 부른다.
 *
 * 모든 응답에 실려 오는 헤더라 계정 조회가 막힌 토큰으로도 읽힌다. 대신 모델별
 * 주간 창(예: Fable)은 이 헤더에 오지 않는다. 초과 사용(`overage-*`)은 창 접두가
 * 없는 별개 헤더라 여기서 걸리지 않는다.
 */
export function parseUnifiedRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
  observedAt: string,
): ProviderRateLimitWindow[] {
  const prefix = 'anthropic-ratelimit-unified-';
  const suffix = '-utilization';
  const windows: ProviderRateLimitWindow[] = [];

  for (const name of Object.keys(headers).sort()) {
    const key = name.toLowerCase();
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) {
      continue;
    }
    const claim = key.slice(prefix.length, -suffix.length);
    if (!claim) {
      continue;
    }

    // 헤더의 사용률은 이미 0..1 이다.
    const utilization = Number(headers[name]);
    const resetSeconds = Number(headers[`${prefix}${claim}-reset`]);
    windows.push({
      type: windowNameFromClaim(claim),
      status: readHeaderStatus(headers[`${prefix}${claim}-status`]),
      utilization: Number.isFinite(utilization) && utilization >= 0 ? Math.min(utilization, 1) : null,
      resetsAt: Number.isFinite(resetSeconds) && resetSeconds > 0
        ? new Date(resetSeconds * 1000).toISOString()
        : null,
      observedAt,
    });
  }
  return windows;
}

/**
 * 1토큰짜리 요청을 보내 응답 헤더만 읽는다. Claude Code 도 시작할 때 같은 식으로
 * 한도를 확인한다. 아주 작지만 실제 요청이라 구독 사용량에 잡힌다 — 그래서 계정
 * 조회가 실패했을 때만 부른다.
 */
const defaultProbeUsage = (
  credentials: ClaudeCredentials,
  observedAt: string,
): Promise<ProviderRateLimitWindow[]> =>
  new Promise((resolve, reject) => {
    const target = new URL(MESSAGES_ENDPOINT);
    const body = JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      // OAuth 토큰으로 추론을 부를 때는 Claude Code 의 시스템 프롬프트가 있어야 받아 준다.
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'quota' }],
    });
    const request = https.request(
      {
        hostname: target.hostname,
        path: target.pathname,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'claude-cli (external, cli)',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        // 본문은 필요 없지만 흘려보내야 소켓이 풀린다.
        response.resume();
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`Claude usage probe failed with ${status}`));
          return;
        }
        resolve(parseUnifiedRateLimitHeaders(response.headers, observedAt));
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Claude usage probe timed out'));
    });
    request.on('error', reject);
    request.end(body);
  });

export function createClaudeUsageService(
  dependencies: Partial<ClaudeUsageServiceDependencies> = {},
) {
  const {
    readCredentials = defaultReadCredentials,
    fetchUsage = defaultFetchUsage,
    probeUsage = defaultProbeUsage,
    readCliUsage = () => claudeCliUsageService.getSnapshot(),
    now = () => Date.now(),
  } = dependencies;

  /** 계정(configDir)마다 따로 캐싱한다 — 서로 다른 계정이 서로의 값을 가리면 안 된다. */
  const cacheByAccount = new Map<string, { at: number; snapshot: ClaudeUsageSnapshot }>();

  /** 계정 조회가 막혔을 때 응답 헤더로 읽은 값. 이것도 실패하면 빈 목록. */
  const readProbeSnapshot = async (
    credentials: ClaudeCredentials,
    observedAt: string,
  ): Promise<ClaudeUsageSnapshot> => {
    try {
      const windows = await probeUsage(credentials, observedAt);
      return { windows, planType: credentials.subscriptionType, source: 'live' };
    } catch (error) {
      console.warn('[Claude usage] Failed to probe usage headers:', error);
      return { windows: [] };
    }
  };

  /** 계정에 직접 물어본 값. 자격증명을 못 읽거나 요청이 실패하면 헤더로 읽은 값. */
  const readAccountSnapshot = async (configDir?: string | null): Promise<ClaudeUsageSnapshot> => {
    const credentials = await readCredentials(configDir);
    if (!credentials) {
      // 로그인하지 않은 상태와 실패를 구분하지 않는다. 물러설 곳이 같다.
      return { windows: [] };
    }

    const observedAt = new Date(now()).toISOString();

    let usage: unknown;
    try {
      usage = await fetchUsage(credentials);
    } catch (error) {
      console.warn('[Claude usage] Failed to read usage:', error);
      return readProbeSnapshot(credentials, observedAt);
    }

    const payload = (usage ?? {}) as Record<string, unknown>;
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

    return { windows, planType: credentials.subscriptionType, source: 'live' };
  };

  return {
    /**
     * 화면에 그릴 창들. 계정에 직접 물어보고, 그 길이 막혀 있으면 CLI 에게
     * `/usage` 를 물어본다(서버 기본 계정을 물을 때만 — CLI 는 이 프로세스의
     * 계정 하나만 보므로 다른 계정을 물을 땐 건너뛴다). 둘 다 못 읽으면 빈
     * 목록 — 부른 쪽이 쌓아 둔 이벤트로 물러설 수 있다.
     */
    async getSnapshot(configDir?: string | null): Promise<ClaudeUsageSnapshot> {
      const cacheKey = configDir ?? '';
      const cached = cacheByAccount.get(cacheKey);
      if (cached && now() - cached.at < CACHE_TTL_MS) {
        return cached.snapshot;
      }

      let snapshot = await readAccountSnapshot(configDir);
      if (snapshot.windows.length === 0 && !configDir) {
        const cli = await readCliUsage();
        if (cli.windows.length > 0) {
          snapshot = { windows: cli.windows, source: 'cli' };
        }
      }

      // 빈 결과는 캐시하지 않는다. 로그인을 막 끝낸 직후에도 다음 요청이 바로
      // 값을 가져올 수 있어야 한다.
      if (snapshot.windows.length > 0) {
        cacheByAccount.set(cacheKey, { at: now(), snapshot });
      }
      return snapshot;
    },

    /** 테스트와, 로그인 직후처럼 캐시가 거짓이 되는 순간을 위해. */
    clearCache(): void {
      cacheByAccount.clear();
    },
  };
}

export const claudeUsageService = createClaudeUsageService();
