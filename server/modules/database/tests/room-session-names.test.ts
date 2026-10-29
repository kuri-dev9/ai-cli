import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';

/**
 * 참가자 세션 이름 앞의 `[룸] ` 은 사이드바가 참가자를 룸 아래에 접어 보여 주면서
 * 군더더기가 됐다. 이미 그렇게 지어진 이름은 다음 기동 때 떨어져야 한다.
 */
test('다시 띄우면 참가자 세션 이름 앞의 [룸] 이 떨어진다', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'room-session-names-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');

  try {
    await initializeDatabase();
    sessionsDb.createAppSession('member', 'claude', tempDirectory, 'x');
    sessionsDb.updateSessionCustomName('member', '[룸] 빌더 · 구현자');
    sessionsDb.createAppSession('plain', 'claude', tempDirectory, 'x');
    // 사용자가 직접 지은 이름은 띄어쓰기가 없으면 건드리지 않는다.
    sessionsDb.updateSessionCustomName('plain', '[룸]메모');
    closeConnection();

    await initializeDatabase();
    assert.equal(sessionsDb.getSessionById('member')?.custom_name, '빌더 · 구현자');
    assert.equal(sessionsDb.getSessionById('plain')?.custom_name, '[룸]메모');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
