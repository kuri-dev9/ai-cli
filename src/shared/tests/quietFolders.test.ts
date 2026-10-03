import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  addQuietFolder,
  isPathInQuietFolders,
  normalizeQuietFolderPath,
  readQuietFolders,
  removeQuietFolder,
  setQuietFoldersExpanded,
} from '@/shared/quietFolders';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * 조용한 폴더는 "어느 프로젝트를 맨 아래 묶음으로 보낼지" 를 경로 규칙으로 정한다.
 * 지켜야 할 것: 폴더 자신과 그 아래만 잡고 이름이 비슷한 옆 폴더는 놓아 두기,
 * 루트·상대 경로처럼 실수로 보이는 값은 받지 않기.
 */

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

test('설정한 적이 없으면 빈 목록, 접힌 상태다', () => {
  assert.deepEqual(readQuietFolders(), { paths: [], expanded: false });
});

test('폴더 자신과 그 아래는 잡고, 이름이 겹치는 옆 폴더는 놓아 둔다', () => {
  const quiet = ['/work/llm-sim/runs'];

  assert.equal(isPathInQuietFolders('/work/llm-sim/runs', quiet), true);
  assert.equal(isPathInQuietFolders('/work/llm-sim/runs/bt-1/2026-09-22/premarket', quiet), true);
  assert.equal(isPathInQuietFolders('/work/llm-sim/runs-old', quiet), false);
  assert.equal(isPathInQuietFolders('/work/llm-sim', quiet), false);
  assert.equal(isPathInQuietFolders(null, quiet), false);
});

test('끝의 슬래시와 겹친 슬래시, 윈도우 구분자는 같은 폴더로 본다', () => {
  assert.equal(normalizeQuietFolderPath(' /tmp/ '), '/tmp');
  assert.equal(normalizeQuietFolderPath('/a//b///'), '/a/b');
  assert.equal(normalizeQuietFolderPath('C:\\work\\runs\\'), 'C:/work/runs');
  assert.equal(isPathInQuietFolders('C:\\work\\runs\\day-1', ['C:/work/runs']), true);
});

test('루트와 상대 경로, ~ 경로는 받지 않는다', () => {
  for (const input of ['/', '///', 'C:\\', 'runs', '~/runs', '']) {
    assert.equal(normalizeQuietFolderPath(input), '', input);
    assert.equal(addQuietFolder(input), false, input);
  }
  assert.deepEqual(readQuietFolders().paths, []);
});

test('같은 폴더는 한 번만 들어가고, 빼면 사라진다', () => {
  assert.equal(addQuietFolder('/tmp'), true);
  assert.equal(addQuietFolder('/tmp/'), false);
  assert.equal(addQuietFolder('/private/tmp'), true);
  assert.deepEqual(readQuietFolders().paths, ['/tmp', '/private/tmp']);

  removeQuietFolder('/tmp');
  assert.deepEqual(readQuietFolders().paths, ['/private/tmp']);
});

test('펼치고 접기만 하면 경로 배열은 같은 참조를 유지한다', () => {
  addQuietFolder('/tmp');
  const before = readQuietFolders().paths;

  setQuietFoldersExpanded(true);

  assert.equal(readQuietFolders().expanded, true);
  assert.equal(readQuietFolders().paths, before);
});

test('손상된 저장값은 쓸 수 있는 항목만 남긴다', () => {
  writeUserPreference('quietFolders', { paths: ['/ok', 3, '/', '/ok/', 'rel'], expanded: 'yes' });

  assert.deepEqual(readQuietFolders(), { paths: ['/ok'], expanded: false });
});
