import assert from 'node:assert/strict';

import { render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { storeAuthToken } from '@/shared/authToken';

// JWT-shaped string; only the payload is ever decoded (see authToken.test.ts).
const makeToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 3600 })}.sig`;
};

beforeEach(() => {
  localStorage.clear();
  // The player streams from an authenticated URL, so a usable token must exist.
  storeAuthToken(makeToken());
});

afterEach(() => {
  document.body.innerHTML = '';
});

const renderMarkdown = (markdown: string) => render(<Markdown>{markdown}</Markdown>);

test('clicking an audio path opens a player underneath it', () => {
  const track = '/Users/me/.soriforge/tracks/7079962e-84c6-4666-8290-c7c3baf82e66-0.flac';
  const { container } = renderMarkdown(`파일: \`${track}\` (4.3MB, FLAC)`);

  const button = container.querySelector('button');
  assert.ok(button, 'a playable path must be actionable');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(container.querySelector('audio'), null, 'the player stays closed until asked for');

  fireEvent.click(button);

  const audio = container.querySelector('audio');
  assert.ok(audio, 'the player opens in place');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(audio.hasAttribute('controls'), true);

  // It must stream from the media endpoint rather than download a blob first.
  const src = new URL(audio.getAttribute('src') ?? '', 'http://localhost');
  assert.equal(src.pathname, '/api/file-tree/media/content');
  assert.equal(src.searchParams.get('path'), track);
  assert.ok(src.searchParams.get('token'), 'a media element cannot send the auth header');
});

test('clicking again collapses the player', () => {
  const { container } = renderMarkdown('`/Users/me/tracks/song.flac`');
  const button = container.querySelector('button');
  assert.ok(button);

  fireEvent.click(button);
  assert.ok(container.querySelector('audio'));

  fireEvent.click(button);
  assert.equal(container.querySelector('audio'), null);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('a video path opens a video element instead', () => {
  const { container } = renderMarkdown('`/Users/me/clips/demo.mp4`');
  const button = container.querySelector('button');
  assert.ok(button);

  fireEvent.click(button);

  assert.ok(container.querySelector('video'), 'video must not be squeezed into an audio element');
  assert.equal(container.querySelector('audio'), null);
});

test('ordinary inline code is left as inert code', () => {
  // Identifiers, MIME types and non-playable files must not become buttons.
  for (const span of ['rate_track', 'lyrics', 'audio/flac', 'src/presets/compile.ts', 'package.json', 'v1.37.3']) {
    const { container } = renderMarkdown(`\`${span}\``);
    assert.equal(container.querySelector('button'), null, `${span} must not be a play button`);
    assert.ok(container.querySelector('code'), `${span} must stay code`);
    document.body.innerHTML = '';
  }
});

test('a shell snippet that merely ends in a media extension is not a path', () => {
  // `afplay ~/x.flac` ends in .flac but is a command, not something to open.
  const { container } = renderMarkdown('`afplay ~/.soriforge/tracks/song.flac`');

  assert.equal(container.querySelector('button'), null);
  assert.ok(container.querySelector('code'));
});
