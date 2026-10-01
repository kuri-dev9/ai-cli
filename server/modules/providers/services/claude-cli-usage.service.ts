/**
 * `claude -p "/usage"` 로 구독 한도를 읽는다.
 *
 * 계정에 직접 물어보는 길(`claude-usage.service`)이 막히는 설치가 있다. 토큰이
 * 파일에도 키체인에도 없거나(기업 게이트웨이·헬퍼 스크립트), 저장된 access token
 * 이 만료돼 CLI 만 갱신할 수 있는 상태인 경우다. 그때 화면은 "보고되지 않음" 만
 * 남는다 — 정작 같은 호스트에서 `claude` 를 띄워 `/usage` 를 치면 값이 나오는데도.
 *
 * 그래서 마지막 수단으로 CLI 에게 그대로 물어본다. `/usage` 는 print 모드에서
 * 턴을 소비하지 않고(요청 0회, 비용 0) 바로 요약 문단을 돌려주므로, 사용량 화면을
 * 열 때마다 불러도 부담이 없다. 출력은 사람이 읽는 문장이라 형식이 바뀔 수 있다 —
 * 못 읽은 줄은 버리고, 하나도 못 읽으면 빈 결과로 떨어뜨려 부른 쪽이 쌓아 둔
 * 이벤트로 물러설 수 있게 한다.
 */

import os from 'node:os';

import spawn from 'cross-spawn';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { ProviderRateLimitWindow } from '@/shared/types.js';
import { buildScopedWeeklyWindowName } from '@/shared/utils.js';

/** `/usage` 는 모델을 부르지 않는다. 그래도 CLI 기동이 걸리는 호스트가 있어 넉넉히 준다. */
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * 한 줄에서 창 하나를 읽는다. 실제 출력:
 *   Current session: 8% used · resets Oct 1 at 12:49pm (Asia/Seoul)
 *   Current week (all models): 6% used · resets Oct 6 at 5:59pm (Asia/Seoul)
 *   Current week (Fable): 0% used · resets Oct 6 at 6pm (Asia/Seoul)
 * 구분자(`·`)와 reset 부분은 없을 수도 있다고 보고 선택으로 둔다.
 */
const USAGE_LINE = /current\s+(session|week)\s*(?:\(([^)]*)\))?\s*:\s*([\d.]+)\s*%\s*used\s*(?:[·.,-]\s*resets?\s+([^\n]+))?/i;

/**
 * `Oct 1 at 12:49pm (Asia/Seoul)`. 분과 am/pm 은 빠질 수 있고(`6pm`, 24시간 표기),
 * 시간대도 괄호째 없을 수 있다. 연도는 아예 출력되지 않는다.
 */
const RESET_TIME = /^([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

const MONTH_INDEX_BY_PREFIX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * 사용률로 상태를 매긴다. CLI 출력에는 API 가 주는 `severity` 가 없어서, 다 쓴 창을
 * 정상으로 그리지 않을 만큼만 직접 나눈다.
 */
const WARNING_UTILIZATION = 0.8;

/** 연도가 없는 날짜를 올해로 읽었을 때, 이만큼 지난 값이면 내년 것으로 본다(12월→1월). */
const PAST_RESET_TOLERANCE_MS = 45 * 24 * 60 * 60 * 1000;

export type ClaudeCliUsageSnapshot = {
  windows: ProviderRateLimitWindow[];
};

type ClaudeCliUsageServiceDependencies = {
  /** `claude -p "/usage" --output-format json` 의 stdout. 실패는 null. */
  runUsageCommand: () => Promise<string | null>;
  now: () => number;
};

const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>();

const getTimeZoneFormatter = (timeZone: string): Intl.DateTimeFormat | null => {
  const cached = timeZoneFormatters.get(timeZone);
  if (cached) {
    return cached;
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    timeZoneFormatters.set(timeZone, formatter);
    return formatter;
  } catch {
    // 모르는 시간대 이름이면 변환을 포기하고 서버 로컬 시각으로 읽는다.
    return null;
  }
};

/** `timestamp` 순간을 `timeZone` 의 벽시계로 읽어, 그 숫자를 UTC 로 본 값. */
const wallClockAsUtc = (timestamp: number, formatter: Intl.DateTimeFormat): number => {
  const parts = formatter.formatToParts(new Date(timestamp));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // 자정을 24 로 주는 ICU 빌드가 있다.
    read('hour') % 24,
    read('minute'),
    read('second'),
  );
};

/**
 * 어떤 시간대의 벽시계 시각을 실제 순간(epoch ms)으로 바꾼다. 오프셋을 한 번 구해
 * 보정하고, DST 경계에서 어긋나지 않게 보정한 값으로 한 번 더 구한다.
 */
const zonedWallClockToEpoch = (
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string | null,
): number => {
  const naive = Date.UTC(year, monthIndex, day, hour, minute);
  const formatter = timeZone ? getTimeZoneFormatter(timeZone) : null;
  if (!formatter) {
    return new Date(year, monthIndex, day, hour, minute).getTime();
  }

  let epoch = naive - (wallClockAsUtc(naive, formatter) - naive);
  epoch = naive - (wallClockAsUtc(epoch, formatter) - epoch);
  return epoch;
};

/** `resets ...` 뒤쪽을 ISO 로. 형식이 다르면 null — 막대는 초기화 시각 없이도 그려진다. */
const parseResetTimestamp = (raw: string, nowMs: number): string | null => {
  const match = RESET_TIME.exec(raw.trim());
  if (!match) {
    return null;
  }

  const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
  const monthIndex = MONTH_INDEX_BY_PREFIX[monthName.slice(0, 3).toLowerCase()];
  if (monthIndex === undefined) {
    return null;
  }

  const day = Number(dayText);
  let hour = Number(hourText);
  const minute = Number(minuteText ?? '0');
  if (meridiem) {
    const isAfternoon = meridiem.toLowerCase() === 'pm';
    hour = (hour % 12) + (isAfternoon ? 12 : 0);
  }
  if (day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }

  // 출력에 연도가 없다. 올해로 읽되, 한참 지난 값이면 해를 넘긴 것으로 본다.
  const year = new Date(nowMs).getUTCFullYear();
  const zone = timeZone?.trim() || null;
  let epoch = zonedWallClockToEpoch(year, monthIndex, day, hour, minute, zone);
  if (epoch < nowMs - PAST_RESET_TOLERANCE_MS) {
    epoch = zonedWallClockToEpoch(year + 1, monthIndex, day, hour, minute, zone);
  }

  return Number.isNaN(epoch) ? null : new Date(epoch).toISOString();
};

/**
 * 창 이름. 이벤트·API 쪽이 쓰는 이름과 똑같이 맞춘다 — 화면이 라벨을 한 벌만
 * 들고 있으면 되도록.
 */
const windowNameFor = (period: string, scope: string | undefined): string => {
  if (period.toLowerCase() === 'session') {
    return 'five_hour';
  }

  const normalizedScope = scope?.trim().toLowerCase() ?? '';
  if (!normalizedScope || normalizedScope === 'all models') {
    return 'seven_day';
  }

  return buildScopedWeeklyWindowName(normalizedScope) ?? 'seven_day';
};

const statusFor = (utilization: number): ProviderRateLimitWindow['status'] => {
  if (utilization >= 1) {
    return 'rejected';
  }
  return utilization >= WARNING_UTILIZATION ? 'allowed_warning' : 'allowed';
};

/** `/usage` 본문에서 창들을 읽는다. 같은 창이 두 번 나오면 먼저 나온 줄을 쓴다. */
const parseUsageText = (text: string, nowMs: number): ProviderRateLimitWindow[] => {
  const observedAt = new Date(nowMs).toISOString();
  const windows = new Map<string, ProviderRateLimitWindow>();

  for (const line of text.split(/\r?\n/)) {
    const match = USAGE_LINE.exec(line);
    if (!match) {
      continue;
    }

    const [, period, scope, percentText, resetText] = match;
    const percent = Number(percentText);
    if (!Number.isFinite(percent) || percent < 0) {
      continue;
    }

    const type = windowNameFor(period, scope);
    if (windows.has(type)) {
      continue;
    }

    // 넘긴 경우 막대가 사라지는 대신 가득 찬 것으로 읽히게 잘라 둔다.
    const utilization = Math.min(percent, 100) / 100;
    windows.set(type, {
      type,
      status: statusFor(utilization),
      utilization,
      resetsAt: resetText ? parseResetTimestamp(resetText, nowMs) : null,
      observedAt,
    });
  }

  return [...windows.values()];
};

/** `--output-format json` 응답에서 사람이 보는 본문만 꺼낸다. */
const readCommandOutputText = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const result = (parsed as Record<string, unknown> | null)?.result;
    return typeof result === 'string' ? result : '';
  } catch {
    // JSON 이 아니면 CLI 가 평문으로 답한 것이다. 그대로 읽어 본다.
    return stdout;
  }
};

const defaultRunUsageCommand = (): Promise<string | null> =>
  new Promise((resolve) => {
    // cross-spawn 이 PATH 와 shim 을 알아서 풀어 주므로 맨 이름도 여기서는 쓸 만하다.
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH) ?? 'claude';
    let child;
    try {
      // 세션을 디스크에 남기지 않는다. 남기면 화면을 열 때마다 홈 프로젝트에
      // "/usage" 한 줄짜리 세션이 생기고 새 세션 알림까지 뜬다.
      child = spawn(cliPath, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], {
        // 프로젝트 디렉터리에 매이지 않게 홈에서 돌린다. `/usage` 는 파일을 보지 않는다.
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? stdout : null));
  });

/** Claude 사용량 서비스가 직접 물어보기에 실패했을 때 쓰는 보조 경로. */
export function createClaudeCliUsageService(
  dependencies: Partial<ClaudeCliUsageServiceDependencies> = {},
) {
  const {
    runUsageCommand = defaultRunUsageCommand,
    now = () => Date.now(),
  } = dependencies;

  return {
    /** 읽어 낸 창들. CLI 가 없거나 출력이 달라졌으면 빈 목록. */
    async getSnapshot(): Promise<ClaudeCliUsageSnapshot> {
      let stdout: string | null;
      try {
        stdout = await runUsageCommand();
      } catch (error) {
        console.warn('[Claude usage] Failed to run /usage:', error);
        return { windows: [] };
      }

      if (!stdout) {
        return { windows: [] };
      }

      return { windows: parseUsageText(readCommandOutputText(stdout), now()) };
    },
  };
}

/** `claude-usage.service` 가 물러설 곳으로 쓴다. */
export const claudeCliUsageService = createClaudeCliUsageService();
