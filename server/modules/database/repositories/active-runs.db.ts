import { getConnection } from '@/modules/database/connection.js';

/** 이 실행을 누가 이어 가는지. 룸 참가자의 차례는 룸 엔진이 자기 흐름대로 이어 간다. */
export type ActiveRunOwner = 'chat' | 'room';

export type ActiveRunRow = {
  session_id: string;
  run_id: string;
  provider: string;
  origin: string;
  owner: ActiveRunOwner;
  user_id: string | null;
  options: string;
  resume_count: number;
  started_at: string;
};

const COLUMNS = 'session_id, run_id, provider, origin, owner, user_id, options, resume_count, started_at';

/**
 * 지금 돌고 있는 실행의 기록.
 *
 * 시작할 때 넣고 끝나면 지운다. 서버가 내려가면 지울 틈이 없으므로, 다시 떴을
 * 때 남아 있는 행이 곧 끊긴 실행이다. 종료 신호에 기대지 않아서 서버가 죽거나
 * 강제로 꺼진 경우도 똑같이 남는다.
 */
export const activeRunsDb = {
  /** 세션당 하나다. 같은 세션의 새 실행은 앞의 행을 덮어쓴다. */
  start(input: {
    sessionId: string;
    runId: string;
    provider: string;
    origin: string;
    owner: ActiveRunOwner;
    userId: string | number | null;
    options: unknown;
    resumeCount: number;
  }): void {
    getConnection()
      .prepare(
        `INSERT INTO active_runs (session_id, run_id, provider, origin, owner, user_id, options, resume_count, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id) DO UPDATE SET
           run_id = excluded.run_id,
           provider = excluded.provider,
           origin = excluded.origin,
           owner = excluded.owner,
           user_id = excluded.user_id,
           options = excluded.options,
           resume_count = excluded.resume_count,
           started_at = excluded.started_at`,
      )
      .run(
        input.sessionId,
        input.runId,
        input.provider,
        input.origin,
        input.owner,
        input.userId === null ? null : String(input.userId),
        JSON.stringify(input.options ?? {}),
        input.resumeCount,
      );
  },

  /** 이 실행의 행만 지운다. 그 사이 같은 세션에서 새 실행이 시작됐으면 그 행은 둔다. */
  finish(sessionId: string, runId: string): void {
    getConnection().prepare('DELETE FROM active_runs WHERE session_id = ? AND run_id = ?').run(sessionId, runId);
  },

  list(): ActiveRunRow[] {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM active_runs ORDER BY started_at`).all() as ActiveRunRow[];
  },

  remove(sessionId: string): void {
    getConnection().prepare('DELETE FROM active_runs WHERE session_id = ?').run(sessionId);
  },
};
