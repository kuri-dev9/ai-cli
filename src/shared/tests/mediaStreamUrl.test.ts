import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import { mediaStreamUrl } from '@/shared/api';
import { storeAuthToken } from '@/shared/authToken';

// JWT-shaped string; only the payload is ever decoded (see authToken.test.ts).
const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

const liveToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ iat: now - 60, exp: now + 3600 });
};

beforeEach(() => {
  localStorage.clear();
});

test('mediaStreamUrl points at the media endpoint and carries the token in the query', () => {
  const token = liveToken();
  storeAuthToken(token);

  const url = mediaStreamUrl('/Users/me/generated/song.flac');

  assert.ok(url);
  const parsed = new URL(url, 'http://localhost');
  assert.equal(parsed.pathname, '/api/file-tree/media/content');
  // A media element cannot set the auth header, so the token must ride along.
  assert.equal(parsed.searchParams.get('token'), token);
  assert.equal(parsed.searchParams.get('path'), '/Users/me/generated/song.flac');
});

test('mediaStreamUrl encodes paths with spaces and non-ASCII names', () => {
  storeAuthToken(liveToken());

  const filePath = '/Users/me/소리/첫 번째 곡 #1.flac';
  const url = mediaStreamUrl(filePath);

  assert.ok(url);
  assert.ok(!url.includes(' '), 'a raw space would truncate the query');
  assert.ok(!url.includes('#'), 'a raw # would start a fragment and drop the rest');
  assert.equal(new URL(url, 'http://localhost').searchParams.get('path'), filePath);
});

test('mediaStreamUrl returns null without a token instead of a request that will 401', () => {
  assert.equal(mediaStreamUrl('/Users/me/generated/song.flac'), null);
});

test('mediaStreamUrl returns null for an expired token', () => {
  const now = Math.floor(Date.now() / 1000);
  // Written straight to storage: storeAuthToken would be the app's own refresh
  // path, and this asserts what happens to a token that expired while stored.
  localStorage.setItem('auth-token', makeToken({ iat: now - 7200, exp: now - 3600 }));

  assert.equal(mediaStreamUrl('/Users/me/generated/song.flac'), null);
});
