import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  addRoomRolePreset,
  DEFAULT_ROOM_ROLE_PRESETS,
  deleteRoomRolePreset,
  isValidRoomDisplayName,
  moveRoomRolePreset,
  pickAvailableDisplayName,
  readRoomRolePresets,
  resetRoomRolePresets,
  updateRoomRolePreset,
} from '@/modules/rooms/utils/roomRolePresets';

beforeEach(() => {
  localStorage.clear();
  // 사용자 설정은 메모리 사본을 따로 들고 있어 저장소를 비워도 남는다.
  resetRoomRolePresets();
});

test('the defaults are used until the user changes anything', () => {
  assert.equal(readRoomRolePresets(), DEFAULT_ROOM_ROLE_PRESETS);
  assert.deepEqual(readRoomRolePresets().map((preset) => preset.displayName), ['아키', '빌더', '체커', '테스티', '딴지', '서기']);
  // 기본 프리셋 이름은 모두 서버가 받는 이름이다.
  assert.ok(DEFAULT_ROOM_ROLE_PRESETS.every((preset) => isValidRoomDisplayName(preset.displayName)));
});

test('presets can be added, edited, reordered and deleted, and deletions stick', () => {
  const added = addRoomRolePreset({ displayName: '보안관', roleName: '보안 리뷰어', rolePrompt: '보안만 본다', provider: 'codex' });
  assert.ok(added);
  assert.equal(readRoomRolePresets().at(-1)?.displayName, '보안관');

  assert.equal(updateRoomRolePreset(added.id, { displayName: '보안관', roleName: '보안 감사', rolePrompt: '', provider: null }), true);
  assert.equal(readRoomRolePresets().at(-1)?.roleName, '보안 감사');

  moveRoomRolePreset(added.id, -1);
  assert.equal(readRoomRolePresets().at(-2)?.id, added.id);

  deleteRoomRolePreset('default-devil');
  deleteRoomRolePreset(added.id);
  const names = readRoomRolePresets().map((preset) => preset.displayName);
  assert.ok(!names.includes('딴지'));
  assert.ok(!names.includes('보안관'));
  assert.equal(names.length, DEFAULT_ROOM_ROLE_PRESETS.length - 1);

  resetRoomRolePresets();
  assert.equal(readRoomRolePresets(), DEFAULT_ROOM_ROLE_PRESETS);
});

test('invalid presets are refused instead of saved', () => {
  assert.equal(addRoomRolePreset({ displayName: '두 단어', roleName: '역할', rolePrompt: '', provider: null }), null);
  assert.equal(addRoomRolePreset({ displayName: '이름', roleName: '  ', rolePrompt: '', provider: null }), null);
  assert.equal(updateRoomRolePreset('default-builder', { displayName: '@빌더', roleName: '구현자', rolePrompt: '', provider: null }), false);
  assert.equal(readRoomRolePresets(), DEFAULT_ROOM_ROLE_PRESETS);
});

test('a preset name already in the room gets a number so the same role can join twice', () => {
  assert.equal(pickAvailableDisplayName('빌더', ['아키']), '빌더');
  assert.equal(pickAvailableDisplayName('빌더', ['아키', '빌더']), '빌더2');
  assert.equal(pickAvailableDisplayName('빌더', ['빌더', '빌더2']), '빌더3');
});
