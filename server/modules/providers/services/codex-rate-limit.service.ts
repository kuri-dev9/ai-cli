/**
 * Codex 구독 한도 구간.
 *
 * Claude 와 달리 스트림으로는 받을 수 없다. ai-cli 가 쓰는 `@openai/codex-sdk`
 * 는 `codex exec --experimental-json` 의 stdout 을 읽는데, 그 스트림이 내보내는
 * 이벤트는 turn/item 계열 여섯 가지뿐이고 한도를 나르는
 * `account/rateLimits/updated` 는 app-server(JSON-RPC) 전용 알림이기 때문이다.
 *
 * 그래서 로그인해 둔 토큰으로 ChatGPT 백엔드에 직접 물어본다. 문서화된 API 가
 * 아니라 언제든 모양이 바뀔 수 있으므로, 실패는 모두 "보고되지 않음"으로 떨어뜨리고
 * 한도 화면이 통째로 깨지지 않게 한다.
 *
 * 이벤트를 기다리지 않아도 되는 대신 매번 망을 타므로, 새로고침 연타가 그대로
 * 요청이 되지 않도록 짧게 캐시한다.
 */

import fsp from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import type { ProviderRateLimitSnapshot, ProviderRateLimitWindow } from '@/shared/types.js';

const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/codex/usage';

/** 새로고침 연타가 그대로 요청이 되지 않을 만큼만. */
const CACHE_TTL_MS = 30_000;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * 창 길이(초) → Claude 쪽과 같은 이름. 같은 이름을 쓰면 UI 가 프로바이더별로
 * 라벨을 따로 들고 있지 않아도 된다.
 *
 * 응답은 `primary_window`/`secondary_window` 라는 자리 이름만 주고 길이는 따로
 * 알려주므로, 자리가 아니라 길이로 판별한다. 요금제가 바뀌어 창 길이가 달라져도
 * 라벨이 어긋나지 않는다.
 */
const WINDOW_NAMES_BY_SECONDS: Record<number, string> = {
  18_000: 'five_hour',
  604_800: 'seven_day',
};

/** 길이를 모르는 창에 붙일 이름. UI 는 모르는 type 도 그대로 그린다. */
const fallbackWindowName = (slot: string, seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return slot;
  }
  const hours = Math.round(seconds / 3600);
  return hours >= 24 ? `${Math.round(hours / 24)}_day` : `${hours}_hour`;
};

/**
 * 한도에 얼마나 다가갔는지를 Claude 의 status 어휘로 옮긴다. 응답에는
 * `limit_reached` 밖에 없어서, 경고 구간은 여기서 정한다.
 */
const WARNING_THRESHOLD_PERCENT = 80;

type CodexAuthTokens = {
  accessToken: string;
  accountId: string;
};

type CodexRateLimitServiceDependencies = {
  readAuthFile: () => Promise<string>;
  fetchUsage: (tokens: CodexAuthTokens) => Promise<unknown>;
  now: () => number;
};

const readPercent = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  // 넘긴 경우 막대가 사라지는 대신 가득 찬 것으로 읽히게 잘라 둔다.
  return Math.min(parsed, 100) / 100;
};

const readResetsAt = (value: unknown): string | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  // `reset_at` 은 초 단위 epoch 다.
  const date = new Date(parsed * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toWindow = (
  slot: string,
  raw: unknown,
  limitReached: boolean,
  observedAt: string,
): ProviderRateLimitWindow | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const payload = raw as Record<string, unknown>;
  const seconds = Number(payload.limit_window_seconds);
  const utilization = readPercent(payload.used_percent);

  return {
    type: WINDOW_NAMES_BY_SECONDS[seconds] ?? fallbackWindowName(slot, seconds),
    status: limitReached
      ? 'rejected'
      : utilization !== null && utilization * 100 >= WARNING_THRESHOLD_PERCENT
        ? 'allowed_warning'
        : 'allowed',
    utilization,
    resetsAt: readResetsAt(payload.reset_at),
    observedAt,
  };
};

const defaultReadAuthFile = () =>
  fsp.readFile(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8');

/**
 * 전역 `fetch`(undici) 가 아니라 `node:https` 로 부른다.
 *
 * 같은 URL 과 같은 헤더인데도 undici 로 보내면 chatgpt.com 앞단이 403 HTML 을
 * 돌려준다 — 토큰 문제가 아니라 클라이언트를 보고 막는 것이다. `node:https` 로
 * 보내면 그대로 200 이 온다. 헤더를 더 얹어 우회하려 들지 않고, 통하는 쪽을 쓴다.
 */
const defaultFetchUsage = (tokens: CodexAuthTokens): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const target = new URL(USAGE_ENDPOINT);
    const request = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'chatgpt-account-id': tokens.accountId,
          // Codex CLI 가 보내는 값. 빠뜨리면 거절하는 경로가 있다.
          originator: 'codex_cli_rs',
          'User-Agent': 'codex_cli_rs',
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
            reject(new Error(`Codex usage request failed with ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('Codex usage response was not JSON'));
          }
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Codex usage request timed out'));
    });
    request.on('error', reject);
    request.end();
  });

export function createCodexRateLimitService(
  dependencies: Partial<CodexRateLimitServiceDependencies> = {},
) {
  const {
    readAuthFile = defaultReadAuthFile,
    fetchUsage = defaultFetchUsage,
    now = () => Date.now(),
  } = dependencies;

  let cached: { at: number; snapshot: ProviderRateLimitSnapshot } | null = null;

  const readTokens = async (): Promise<CodexAuthTokens | null> => {
    try {
      const parsed = JSON.parse(await readAuthFile()) as Record<string, unknown>;
      const tokens = parsed?.tokens as Record<string, unknown> | undefined;
      const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : '';
      const accountId = typeof tokens?.account_id === 'string' ? tokens.account_id : '';
      // API 키로만 붙은 계정에는 구독 한도라는 것이 없다.
      return accessToken && accountId ? { accessToken, accountId } : null;
    } catch {
      return null;
    }
  };

  return {
    async getSnapshot(): Promise<ProviderRateLimitSnapshot> {
      if (cached && now() - cached.at < CACHE_TTL_MS) {
        return cached.snapshot;
      }

      const tokens = await readTokens();
      if (!tokens) {
        // 로그인하지 않은 상태와 실패를 구분하지 않는다. 화면에서 할 말이 같다.
        return { supported: true, windows: [] };
      }

      let usage: unknown;
      try {
        usage = await fetchUsage(tokens);
      } catch (error) {
        console.warn('[Codex rate limits] Failed to read usage:', error);
        return { supported: true, windows: [] };
      }

      const payload = (usage ?? {}) as Record<string, unknown>;
      const rateLimit = (payload.rate_limit ?? {}) as Record<string, unknown>;
      const limitReached = rateLimit.limit_reached === true;
      const observedAt = new Date(now()).toISOString();

      const windows = [
        toWindow('primary_window', rateLimit.primary_window, limitReached, observedAt),
        toWindow('secondary_window', rateLimit.secondary_window, limitReached, observedAt),
      ].filter((window): window is ProviderRateLimitWindow => window !== null);

      const snapshot: ProviderRateLimitSnapshot = {
        supported: true,
        windows,
        planType: typeof payload.plan_type === 'string' ? payload.plan_type : undefined,
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

export const codexRateLimitService = createCodexRateLimitService();
