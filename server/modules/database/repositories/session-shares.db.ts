import { getConnection } from '@/modules/database/connection.js';

/**
 * 세션 공유 링크.
 *
 * 링크 하나가 세션 하나를 연다. 만료·철회된 링크는 지우지 않고 남겨 두고,
 * 열 때마다 `isShareActive` 로 거른다.
 */

export type SessionShareRow = {
  id: number;
  token: string;
  session_id: string;
  permission_mode: string;
  created_by: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

const COLUMNS = 'id, token, session_id, permission_mode, created_by, expires_at, revoked_at, created_at';

/**
 * 지금 쓸 수 있는 링크인지.
 *
 * 만료는 읽을 때 판단한다. 시간이 지났다고 행을 고치는 타이머를 두면, 서버가
 * 꺼져 있던 동안 지난 링크가 다시 뜰 때까지 열려 있게 된다.
 */
export function isShareActive(row: SessionShareRow, now: Date = new Date()): boolean {
  if (row.revoked_at) {
    return false;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

export const sessionSharesDb = {
  create(input: {
    token: string;
    sessionId: string;
    permissionMode: string;
    createdBy: number | null;
    expiresAt: string | null;
  }): SessionShareRow {
    const result = getConnection()
      .prepare(
        `INSERT INTO session_shares (token, session_id, permission_mode, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.token, input.sessionId, input.permissionMode, input.createdBy, input.expiresAt);
    return this.getById(Number(result.lastInsertRowid))!;
  },

  getById(id: number): SessionShareRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM session_shares WHERE id = ?`)
      .get(id) as SessionShareRow | undefined;
    return row ?? null;
  },

  getByToken(token: string): SessionShareRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM session_shares WHERE token = ?`)
      .get(token) as SessionShareRow | undefined;
    return row ?? null;
  },

  /** 이 세션의 링크 중 아직 쓸 수 있는 것. 새것부터. */
  listActiveBySession(sessionId: string): SessionShareRow[] {
    const rows = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM session_shares WHERE session_id = ? AND revoked_at IS NULL ORDER BY id DESC`)
      .all(sessionId) as SessionShareRow[];
    return rows.filter((row) => isShareActive(row));
  },

  revoke(id: number): void {
    getConnection()
      .prepare(`UPDATE session_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), id);
  },

  /**
   * 이 세션의 열린 링크가 쓸 권한을 바꾼다.
   *
   * 게스트 질문은 "이 세션의 권한을 따른다". 세션 권한은 브라우저가 들고
   * 있으므로, 사용자가 바꿀 때마다 화면이 이걸 불러 맞춘다.
   */
  updatePermissionForSession(sessionId: string, permissionMode: string): number {
    const result = getConnection()
      .prepare(`UPDATE session_shares SET permission_mode = ? WHERE session_id = ? AND revoked_at IS NULL`)
      .run(permissionMode, sessionId);
    return result.changes;
  },
};
