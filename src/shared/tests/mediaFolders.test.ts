import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  addMediaFolder,
  mediaFolderLabel,
  normalizeMediaFolderPath,
  readMediaFolders,
  removeMediaFolder,
} from '@/shared/mediaFolders';

beforeEach(() => {
  localStorage.clear();
});

test('normalizeMediaFolderPath accepts absolute paths and tidies them', () => {
  assert.equal(normalizeMediaFolderPath('  /Users/me/tracks/  '), '/Users/me/tracks');
  assert.equal(normalizeMediaFolderPath('/Users//me///tracks'), '/Users/me/tracks');
  assert.equal(normalizeMediaFolderPath('C:\\Users\\me\\tracks'), 'C:/Users/me/tracks');
});

test('normalizeMediaFolderPath rejects what cannot be resolved or would be a mistake', () => {
  // `~` cannot be expanded in a browser and a relative path has no anchor.
  assert.equal(normalizeMediaFolderPath('~/tracks'), '');
  assert.equal(normalizeMediaFolderPath('tracks'), '');
  // Scanning an entire disk is far more likely to be a slip than an intent.
  assert.equal(normalizeMediaFolderPath('/'), '');
  assert.equal(normalizeMediaFolderPath('C:/'), '');
  assert.equal(normalizeMediaFolderPath('   '), '');
});

test('addMediaFolder stores normalized paths and refuses duplicates', () => {
  assert.equal(addMediaFolder('/Users/me/tracks/'), true);
  assert.deepEqual(readMediaFolders(), ['/Users/me/tracks']);

  // Same folder written differently must not be added twice.
  assert.equal(addMediaFolder('/Users//me/tracks'), false);
  assert.equal(addMediaFolder('not-absolute'), false);
  assert.deepEqual(readMediaFolders(), ['/Users/me/tracks']);
});

test('removeMediaFolder drops one folder and leaves the rest', () => {
  addMediaFolder('/Users/me/tracks');
  addMediaFolder('/Users/me/renders');

  removeMediaFolder('/Users/me/tracks');

  assert.deepEqual(readMediaFolders(), ['/Users/me/renders']);
});

test('readMediaFolders returns the same array while the list is unchanged', () => {
  addMediaFolder('/Users/me/tracks');

  // Callers use the result as an effect dependency; a new array each read would
  // re-fetch every folder listing on every unrelated preference write.
  assert.equal(readMediaFolders(), readMediaFolders());
});

test('mediaFolderLabel shows the folder name rather than the whole path', () => {
  assert.equal(mediaFolderLabel('/Users/me/.soriforge/tracks'), 'tracks');
  assert.equal(mediaFolderLabel('/'), '/');
});
