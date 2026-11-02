import { activeRunsDb, sessionsDb } from '@/modules/database/index.js';
import type { ActiveRunRow } from '@/modules/database/index.js';
import { roomTurnEngine } from '@/modules/rooms/index.js';
import { isSessionHandedToTelegram } from '@/modules/telegram-bridge/index.js';
import { activeRunJournal, chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord } from '@/shared/types.js';

/**
 * 서버가 내려가며 끊긴 일을 다시 뜬 서버가 이어 간다.
 *
 * 실행 일지(`active_runs`)에 남은 대화는 그 세션에 "이어서 하라" 고 보내고,
 * 라운드 상태(`rooms.loop_state`)가 남은 룸은 룸 엔진이 이어 간다. 룸 참가자의
 * 차례는 일지에도 남지만 룸이 자기 흐름대로 이어 가므로 여기서는 지우기만 한다.
 */

/** 이보다 오래 꺼져 있었으면 이어 가지 않는다. 며칠 뒤 켰을 때 갑자기 일이 시작되지 않게. */
export const RESUME_WINDOW_MS = 60 * 60 * 1000;

/** 같은 일을 이어 가는 최대 횟수. 이어 가다 또 끊기는 일이 되풀이되지 않게. */
export const MAX_RESUMES = 2;

/** 끊긴 대화에 보내는 말. 대화에 사용자 글로 남는다. */
export const RESUME_PROMPT = '↻ 서버 재시작으로 직전 작업이 중간에 끊겼습니다. 지금까지의 기록을 확인하고, 끊긴 지점부터 이어서 마무리해 주세요.';

/** 서버가 다시 뜬 뒤 무엇을 했는지. 로그와 테스트가 본다. */
export type RunRecoveryReport = {
  /** 마지막 심장 박동이 너무 오래됐거나 없어서 아무것도 이어 가지 않았다. */
  stale: boolean;
  resumedSessions: string[];
  resumedRooms: string[];
  skippedSessions: Array<{ sessionId: string; reason: string }>;
  skippedRooms: string[];
};

function parseUserId(value: string | null): string | number | null {
  if (value === null) return null;
  return /^\d+$/.test(value) ? Number(value) : value;
}

function parseOptions(value: string): AnyRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyRecord : {};
  } catch {
    return {};
  }
}

/** 이 대화를 이어 가지 않는 이유. 이어 가도 되면 null. */
function reasonToSkip(row: ActiveRunRow): string | null {
  if (row.resume_count >= MAX_RESUMES) {
    return `already resumed ${row.resume_count} times`;
  }
  if (!sessionsDb.getSessionById(row.session_id)) {
    return 'the session no longer exists';
  }
  if (chatRunRegistry.isProcessing(row.session_id)) {
    return 'a run is already in progress';
  }
  return null;
}

/**
 * 끊긴 일을 이어 간다. 서버가 뜬 직후, 런타임·텔레그램·룸 엔진이 준비된 뒤에
 * 한 번 부른다. 심장 박동은 여기서 읽고 나서 새로 시작한다 — 먼저 시작하면
 * 언제 꺼졌는지를 잃는다.
 */
export function resumeInterruptedWork(runtime: ProviderRuntimeGateway, now: Date = new Date()): RunRecoveryReport {
  const lastHeartbeat = activeRunJournal.readLastHeartbeat();
  activeRunJournal.startHeartbeat();

  const rows = activeRunsDb.list();
  const roomIds = roomTurnEngine.listInterruptedRooms();
  // 남은 기록은 모두 지운다. 이어 가는 실행은 시작하면서 새로 적힌다.
  for (const row of rows) {
    activeRunsDb.remove(row.session_id);
  }

  const report: RunRecoveryReport = {
    stale: false,
    resumedSessions: [],
    resumedRooms: [],
    skippedSessions: [],
    skippedRooms: [],
  };

  if (!lastHeartbeat || now.getTime() - lastHeartbeat.getTime() > RESUME_WINDOW_MS) {
    report.stale = rows.length > 0 || roomIds.length > 0;
    for (const roomId of roomIds) {
      roomTurnEngine.discardInterruptedRound(roomId);
      report.skippedRooms.push(roomId);
    }
    for (const row of rows) {
      if (row.owner === 'chat') report.skippedSessions.push({ sessionId: row.session_id, reason: 'interrupted too long ago' });
    }
    logReport(report, lastHeartbeat);
    return report;
  }

  for (const roomId of roomIds) {
    if (roomTurnEngine.resumeAfterRestart(roomId, { maxResumes: MAX_RESUMES }) === 'resumed') {
      report.resumedRooms.push(roomId);
    } else {
      report.skippedRooms.push(roomId);
    }
  }

  for (const row of rows) {
    if (row.owner !== 'chat') continue;
    const reason = reasonToSkip(row);
    if (reason) {
      report.skippedSessions.push({ sessionId: row.session_id, reason });
      continue;
    }
    report.resumedSessions.push(row.session_id);
    void runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: parseUserId(row.user_id),
        content: RESUME_PROMPT,
        options: parseOptions(row.options),
        origin: row.origin === 'telegram' ? 'telegram' : 'web',
        resumeCount: row.resume_count + 1,
      },
      { runtime, isSessionHandedToTelegram },
    ).then((result) => {
      if (!result.started) {
        console.warn('[RunRecovery] Could not resume an interrupted run', { sessionId: row.session_id, error: result.error });
      }
    }).catch((error: unknown) => {
      console.error('[RunRecovery] Resuming an interrupted run failed', {
        sessionId: row.session_id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  logReport(report, lastHeartbeat);
  return report;
}

function logReport(report: RunRecoveryReport, lastHeartbeat: Date | null): void {
  const nothing = report.resumedSessions.length + report.resumedRooms.length
    + report.skippedSessions.length + report.skippedRooms.length === 0;
  if (nothing) return;
  console.log('[RunRecovery] 서버 재시작으로 끊긴 일을 확인했습니다', {
    lastHeartbeat: lastHeartbeat?.toISOString() ?? null,
    ...report,
  });
}

/**
 * 서버가 내려가기 시작했다. 종료 처리의 맨 앞에서 부른다 — 이 뒤로 끝나는
 * 실행과 룸 라운드는 "끊긴 것" 으로 남아 다시 뜰 때 이어 간다.
 */
export function beginShutdown(): void {
  activeRunJournal.markStopping();
}

/**
 * 돌고 있는 실행을 끊는다. 남겨 두면 프로바이더 프로세스가 혼자 계속 돌다가,
 * 다시 뜬 서버가 같은 세션에서 이어 가는 실행과 같은 기록 파일에 함께 쓴다.
 * 텔레그램 브리지를 닫은 뒤에 부른다 — 곧 이어 갈 실행의 "중단됨" 알림이 폰에
 * 가지 않게.
 */
export async function abortRunsForShutdown(runtime: ProviderRuntimeGateway, timeoutMs = 5000): Promise<void> {
  const running = chatRunRegistry.listRunningRuns();
  if (running.length === 0) return;
  const aborts = Promise.allSettled(running.map((run) => runtime.abort(run.provider, run.sessionId)));
  await Promise.race([aborts, new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  })]);
}
