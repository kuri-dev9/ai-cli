import assert from 'node:assert/strict';
import test from 'node:test';

import { toIsoTimestamp } from '@/modules/rooms/services/room-records.service.js';

// SQLite 의 CURRENT_TIMESTAMP 는 시간대 없는 UTC 다. 그대로 넘기면 브라우저가
// 현지 시각으로 읽어, 오후 6시 19분에 보낸 글이 "오전 9:19" 로 보였다.
test('SQLite UTC 시각에 UTC 표시를 붙여 넘긴다', () => {
  assert.equal(toIsoTimestamp('2026-10-30 09:19:51'), '2026-10-30T09:19:51Z');
  assert.equal(Date.parse(toIsoTimestamp('2026-10-30 09:19:51')), Date.UTC(2026, 9, 30, 9, 19, 51));
});

test('이미 시간대가 붙은 값은 그대로 둔다', () => {
  assert.equal(toIsoTimestamp('2026-10-30T09:19:51.000Z'), '2026-10-30T09:19:51.000Z');
});
