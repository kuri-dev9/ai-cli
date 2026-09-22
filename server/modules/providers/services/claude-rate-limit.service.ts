/**
 * Claude subscription rate-limit windows.
 *
 * The SDK reports limits through `rate_limit_event`, which fires only when the
 * info *changes* and carries exactly one window per event (the one that was
 * binding at that moment). There is no control request to ask for the current
 * limits, so the only way to show several windows side by side — the session
 * window next to the weekly one, as `/usage` does — is to bank every event as
 * it passes and keep the newest reading per window type.
 *
 * Readings are persisted because the run they arrived on is long gone by the
 * time someone opens the usage screen, and a server restart would otherwise
 * blank the screen until the next turn happens to change a limit.
 */

import { appConfigDb } from '@/modules/database/index.js';

const STORE_KEY = 'claude.rateLimits';

export type ClaudeRateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/**
 * One limit window. `type` is the SDK's `rateLimitType` (`five_hour`,
 * `seven_day`, `seven_day_opus`, …) and is deliberately a plain string: a newer
 * CLI can add buckets, and an unrecognized one should still reach the screen
 * rather than be dropped here.
 */
export type ClaudeRateLimitWindow = {
  type: string;
  status: ClaudeRateLimitStatus | null;
  /** 0..1 as the SDK reports it; null when the event omitted it. */
  utilization: number | null;
  /** ISO timestamp the window resets at, or null when not reported. */
  resetsAt: string | null;
  /** ISO timestamp this reading arrived, so the UI can say how stale it is. */
  observedAt: string;
};

type WindowStore = Record<string, ClaudeRateLimitWindow>;

export type ClaudeRateLimitServiceDependencies = {
  readRaw: () => string | null;
  writeRaw: (value: string) => void;
  now: () => Date;
};

const VALID_STATUSES: ClaudeRateLimitStatus[] = ['allowed', 'allowed_warning', 'rejected'];

/**
 * `resetsAt` is an epoch timestamp, but the SDK type does not pin the unit and
 * builds have reported both. Anything below this bound cannot be a plausible
 * millisecond timestamp (it would land in 1970), so it is read as seconds.
 */
const MILLISECOND_EPOCH_FLOOR = 1e11;

const toIsoTimestamp = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  const milliseconds = value < MILLISECOND_EPOCH_FLOOR ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toUtilization = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }

  // Clamped rather than rejected: a window that has been blown past can report
  // slightly over 1, and the bar should read as full instead of disappearing.
  return Math.min(value, 1);
};

const toStatus = (value: unknown): ClaudeRateLimitStatus | null =>
  VALID_STATUSES.includes(value as ClaudeRateLimitStatus) ? (value as ClaudeRateLimitStatus) : null;

export function createClaudeRateLimitService(
  dependencies: Partial<ClaudeRateLimitServiceDependencies> = {},
) {
  const {
    readRaw = () => appConfigDb.get(STORE_KEY),
    writeRaw = (value: string) => appConfigDb.set(STORE_KEY, value),
    now = () => new Date(),
  } = dependencies;

  const readStore = (): WindowStore => {
    const raw = readRaw();
    if (!raw) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      const store: WindowStore = {};
      for (const [type, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') {
          continue;
        }
        const window = value as Record<string, unknown>;
        if (typeof window.observedAt !== 'string') {
          continue;
        }
        store[type] = {
          type,
          status: toStatus(window.status),
          utilization: typeof window.utilization === 'number' ? window.utilization : null,
          resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
          observedAt: window.observedAt,
        };
      }
      return store;
    } catch {
      // A corrupt blob is not worth failing a run over; the next event rebuilds it.
      return {};
    }
  };

  return {
    /**
     * Banks one `rate_limit_info` payload. Called from the run loop, so it never
     * throws: losing a usage reading must not take the turn down with it.
     */
    record(info: unknown): void {
      if (!info || typeof info !== 'object') {
        return;
      }

      const payload = info as Record<string, unknown>;
      const type = typeof payload.rateLimitType === 'string' ? payload.rateLimitType.trim() : '';
      if (!type) {
        // Without a type there is no window to file the reading under. The event
        // still carries `status`, but a bar needs to know which limit it is.
        return;
      }

      try {
        const store = readStore();
        store[type] = {
          type,
          status: toStatus(payload.status),
          utilization: toUtilization(payload.utilization),
          resetsAt: toIsoTimestamp(payload.resetsAt),
          observedAt: now().toISOString(),
        };
        writeRaw(JSON.stringify(store));
      } catch (error) {
        console.warn('[Claude rate limits] Failed to record usage window:', error);
      }
    },

    /** Newest reading per window, most recently observed first. */
    getSnapshot(): { windows: ClaudeRateLimitWindow[] } {
      const windows = Object.values(readStore()).sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt),
      );
      return { windows };
    },
  };
}

export const claudeRateLimitService = createClaudeRateLimitService();
