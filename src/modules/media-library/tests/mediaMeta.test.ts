import assert from 'node:assert/strict';

import { test } from 'vitest';

import { formatMediaDate, formatMediaDuration } from '@/modules/media-library/utils/mediaMeta';

test('formatMediaDuration reads as a clock, padding only where it must', () => {
  assert.equal(formatMediaDuration(34), '0:34');
  assert.equal(formatMediaDuration(60), '1:00');
  assert.equal(formatMediaDuration(240), '4:00');
  assert.equal(formatMediaDuration(3723), '1:02:03');
});

test('formatMediaDuration returns null while the length is still unknown', () => {
  // A media element reports NaN or Infinity until it has read the metadata.
  assert.equal(formatMediaDuration(null), null);
  assert.equal(formatMediaDuration(Number.NaN), null);
  assert.equal(formatMediaDuration(Number.POSITIVE_INFINITY), null);
  assert.equal(formatMediaDuration(-1), null);
});

test('formatMediaDate accepts both shapes the server sends', () => {
  // ISO from the folder listing, HTTP date from the Last-Modified header.
  assert.ok(formatMediaDate('2026-10-03T10:00:00.000Z', 'en-US'));
  assert.ok(formatMediaDate('Sat, 03 Oct 2026 10:00:00 GMT', 'en-US'));
});

test('formatMediaDate returns null for a missing or unreadable value', () => {
  assert.equal(formatMediaDate(null, 'en-US'), null);
  assert.equal(formatMediaDate(undefined, 'en-US'), null);
  assert.equal(formatMediaDate('not a date', 'en-US'), null);
});
