import { activeRunsDb, appConfigDb } from '@/modules/database/index.js';
import type { ActiveRunOwner } from '@/modules/database/index.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * 돌고 있는 실행을 DB 에 적어 두는 일지.
 *
 * 실행이 시작되면 적고 끝나면 지운다. 서버가 내려가면 지울 틈이 없으므로
 * 다시 떴을 때 남아 있는 것이 끊긴 실행이다. 다시 뜬 서버가 그 세션들에
 * 이어서 하라고 보낸다(`run-recovery` 모듈).
 *
 * 언제 끊겼는지는 심장 박동으로 잰다. 서버가 살아 있는 동안 30초마다 시각을
 * 적어 두면, 다시 떴을 때 마지막 박동이 곧 내려간 시각이다. 실행이 시작된
 * 시각으로 재면 한 시간 넘게 일하던 실행은 방금 끊겼어도 버려진다.
 */

const HEARTBEAT_KEY = 'server_heartbeat_at';
const HEARTBEAT_INTERVAL_MS = 30_000;

/** 기록에서 빼는 실행 옵션. 첨부는 이어 갈 때 다시 보내지 않는다 — 이미 대화에 들어가 있다. */
const OMITTED_OPTION_KEYS = new Set(['attachments', 'images', 'files', 'sessionId']);

let stopping = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function writeHeartbeat(): void {
  try {
    appConfigDb.set(HEARTBEAT_KEY, new Date().toISOString());
  } catch (error) {
    console.error('[RunJournal] Failed to write the heartbeat', { error: error instanceof Error ? error.message : String(error) });
  }
}

function sanitizeOptions(options: AnyRecord): AnyRecord {
  return Object.fromEntries(Object.entries(options).filter(([key]) => !OMITTED_OPTION_KEYS.has(key)));
}

export const activeRunJournal = {
  recordStart(input: {
    sessionId: string;
    runId: string;
    provider: string;
    origin: string;
    owner: ActiveRunOwner;
    userId: string | number | null;
    options: AnyRecord;
    resumeCount: number;
  }): void {
    try {
      activeRunsDb.start({ ...input, options: sanitizeOptions(input.options) });
    } catch (error) {
      // 일지를 못 적었다고 실행을 막지는 않는다. 끊기면 이어 가지 못할 뿐이다.
      console.error('[RunJournal] Failed to record a run start', {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * 실행이 끝났다. 서버가 내려가는 중이면 지우지 않는다 — 그때 끝나는 실행은
   * 대부분 종료에 끌려 끊긴 것이고, 다시 떴을 때 이어 가야 한다.
   */
  recordFinish(sessionId: string, runId: string): void {
    if (stopping) {
      return;
    }
    try {
      activeRunsDb.finish(sessionId, runId);
    } catch (error) {
      console.error('[RunJournal] Failed to record a run end', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /** 서버가 내려가기 시작했다. 이 뒤로 끝나는 실행은 일지에 남겨 둔다. */
  markStopping(): void {
    stopping = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    writeHeartbeat();
  },

  isStopping(): boolean {
    return stopping;
  },

  /** 마지막 심장 박동. 다시 뜬 직후, 박동을 새로 시작하기 전에 읽어야 한다. */
  readLastHeartbeat(): Date | null {
    const value = appConfigDb.get(HEARTBEAT_KEY);
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isNaN(time) ? null : new Date(time);
  },

  startHeartbeat(): void {
    stopping = false;
    writeHeartbeat();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  },

  /** 테스트가 서로 영향을 주지 않게 되돌린다. */
  reset(): void {
    stopping = false;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  },
};
