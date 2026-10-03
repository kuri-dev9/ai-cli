import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  mediaFolderLabel,
  normalizeMediaFolderPath,
  readMediaFolders,
  writeMediaFolders,
} from '@/shared/mediaFolders';

const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';

beforeEach(() => {
  localStorage.clear();
  // User settings keep an in-memory mirror that clearing storage does not
  // touch, so each project's list has to be emptied through its own API.
  writeMediaFolders(PROJECT, []);
  writeMediaFolders(OTHER_PROJECT, []);
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

test('folders are stored per project and do not leak into another one', () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);

  assert.deepEqual(readMediaFolders(PROJECT), ['/Users/me/tracks']);
  assert.deepEqual(readMediaFolders(OTHER_PROJECT), []);
  // A workspace with no project selected has nowhere to read from.
  assert.deepEqual(readMediaFolders(null), []);
});

test('writeMediaFolders normalizes and drops duplicates and junk', () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks/', '/Users//me/tracks', 'not-absolute', '/']);

  assert.deepEqual(readMediaFolders(PROJECT), ['/Users/me/tracks']);
});

test('clearing a project removes its entry without touching the others', () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);
  writeMediaFolders(OTHER_PROJECT, ['/Users/me/renders']);

  writeMediaFolders(PROJECT, []);

  assert.deepEqual(readMediaFolders(PROJECT), []);
  assert.deepEqual(readMediaFolders(OTHER_PROJECT), ['/Users/me/renders']);
});

test('readMediaFolders returns the same array while that project is unchanged', () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);
  const first = readMediaFolders(PROJECT);

  // Editing another project must not hand this one a new array: callers use the
  // result as an effect dependency and would re-fetch every folder listing.
  writeMediaFolders(OTHER_PROJECT, ['/Users/me/renders']);

  assert.equal(readMediaFolders(PROJECT), first);
});

test('mediaFolderLabel shows the folder name rather than the whole path', () => {
  assert.equal(mediaFolderLabel('/Users/me/.soriforge/tracks'), 'tracks');
  assert.equal(mediaFolderLabel('/'), '/');
});
