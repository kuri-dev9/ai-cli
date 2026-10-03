import assert from 'node:assert/strict';

import { render, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import MediaLibraryPanel from '@/modules/media-library/MediaLibraryPanel';
import { writeMediaFolders } from '@/shared/mediaFolders';
import { storeAuthToken } from '@/shared/authToken';

const makeToken = () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 3600 })}.sig`;
};

const PROJECT = 'project-1';

const TRACKS = {
  files: [
    {
      name: 'song.flac',
      path: '/Users/me/tracks/song.flac',
      relativePath: 'song.flac',
      size: 4300000,
      modifiedAt: '2026-10-03T10:00:00.000Z',
      contentType: 'audio/flac',
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  // User settings keep an in-memory mirror that clearing storage does not
  // touch, so the list has to be emptied through its own API.
  writeMediaFolders(PROJECT, []);
  storeAuthToken(makeToken());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/list')) {
      return new Response(JSON.stringify(TRACKS), { status: 200 });
    }
    // Metadata HEAD and any other call: nothing useful, the panel copes.
    return new Response(null, { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('a connected folder lists its tracks and plays one in place', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  // The folder header shows the folder name, not the whole path.
  await findByText('tracks');
  const entry = await findByText('song.flac');
  assert.equal(container.querySelector('audio'), null, 'nothing plays until asked');

  fireEvent.click(entry);

  await waitFor(() => {
    const audio = container.querySelector('audio');
    assert.ok(audio, 'clicking an entry opens a player in the list');
    const src = new URL(audio.getAttribute('src') ?? '', 'http://localhost');
    assert.equal(src.pathname, '/api/file-tree/media/content');
    assert.equal(src.searchParams.get('path'), '/Users/me/tracks/song.flac');
  });
});

test('a project with no folders connected lists nothing', async () => {
  const { container } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await waitFor(() => assert.ok(container.textContent));
  assert.equal(container.querySelector('audio'), null, 'an empty library plays nothing');
  assert.equal(container.querySelector('section'), null, 'no folder sections are listed');
});

test('a file opened from outside plays at the top, above the folders', async () => {
  const { container } = render(
    <MediaLibraryPanel
      projectId={PROJECT}
      openedFilePath="/Users/me/.soriforge/tracks/new.flac"
      onClose={() => undefined}
    />,
  );

  await waitFor(() => {
    const audio = container.querySelector('audio');
    assert.ok(audio, 'the file the workspace opened plays without being in a folder');
    const src = new URL(audio.getAttribute('src') ?? '', 'http://localhost');
    assert.equal(src.searchParams.get('path'), '/Users/me/.soriforge/tracks/new.flac');
  });
});
