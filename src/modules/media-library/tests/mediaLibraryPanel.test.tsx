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

const entry = (name: string, modifiedAt: string) => ({
  name,
  path: `/Users/me/tracks/${name}`,
  relativePath: name,
  size: 4300000,
  modifiedAt,
  contentType: 'audio/flac',
});

// Deliberately not in name order, so a date sort and a name sort differ.
const TRACKS = {
  files: [
    entry('song.flac', '2026-10-03T10:00:00.000Z'),
    entry('another.flac', '2026-10-01T10:00:00.000Z'),
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

  // The header carries the whole path: connected folders often end in the same
  // name, so the tail is what tells them apart.
  await waitFor(() => assert.ok(folderHeader(container).textContent?.includes('/Users/me/tracks')));
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

/** 폴더 머리글 버튼. 라벨이 전체 경로라 텍스트 대신 구조로 찾는다. */
const folderHeader = (container: HTMLElement) => {
  const header = container.querySelector('section > button');
  assert.ok(header, 'a connected folder must have a header');
  return header;
};

/** 펼쳐 둔 항목 안의 마지막 버튼 — 휴지통이다. */
const deleteButton = (container: HTMLElement) => {
  const entry = container.querySelector('li');
  assert.ok(entry);
  const buttons = entry.querySelectorAll('button');
  return buttons[buttons.length - 1];
};

const listedNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('li button > span:first-of-type'))
    .map((element) => element.textContent);

test('collapsing a folder keeps a playing track alive', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  fireEvent.click(await findByText('song.flac'));
  await waitFor(() => assert.ok(container.querySelector('audio')));

  // Collapsing used to unmount the list, which took the player with it and cut
  // the music off. The list must only be hidden.
  fireEvent.click(folderHeader(container));

  assert.ok(container.querySelector('audio'), 'the player must survive collapsing');
});

test('each entry shows when it was made', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await findByText('song.flac');
  const row = container.querySelector('li button');
  assert.ok(row);
  // The date sits beside the name, so the row says more than the filename does.
  assert.ok(row.textContent && row.textContent.length > 'song.flac'.length);
  assert.ok(/2026/.test(row.textContent ?? ''), 'the row must carry the date');
});

test('the list can be ordered by name or by date, newest first by default', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await findByText('song.flac');
  // The two sort controls are the only toggles in the panel, so they are found
  // by role rather than by label — the rendered language varies by environment.
  const [byDate, byName] = Array.from(container.querySelectorAll('button[aria-pressed]'));
  assert.ok(byDate && byName);

  assert.deepEqual(listedNames(container), ['song.flac', 'another.flac'], 'newest first');

  fireEvent.click(byName);
  assert.deepEqual(listedNames(container), ['another.flac', 'song.flac'], 'name ascending');

  // Pressing the active control again flips the direction.
  fireEvent.click(byName);
  assert.deepEqual(listedNames(container), ['song.flac', 'another.flac'], 'name descending');

  fireEvent.click(byDate);
  assert.deepEqual(listedNames(container), ['song.flac', 'another.flac'], 'back to newest first');
});

test('deleting a track asks first, then removes it and its player', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);
  const deleteCalls: string[] = [];
  const confirmed: string[] = [];
  vi.stubGlobal('confirm', (message: string) => {
    confirmed.push(message);
    return true;
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/file')) {
      deleteCalls.push(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('/api/file-tree/media/list')) {
      // After the delete the folder comes back without that track.
      const files = deleteCalls.length > 0 ? [TRACKS.files[1]] : TRACKS.files;
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response(null, { status: 200 });
  }));

  const { container, findByText, queryByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  fireEvent.click(await findByText('song.flac'));
  await waitFor(() => assert.ok(container.querySelector('audio')));

  fireEvent.click(deleteButton(container));

  await waitFor(() => assert.equal(deleteCalls.length, 1));
  assert.equal(confirmed.length, 1, 'an unrecoverable delete must be confirmed');
  assert.ok(deleteCalls[0].includes('/Users/me/tracks/song.flac'));
  await waitFor(() => assert.equal(queryByText('song.flac'), null));
  assert.equal(container.querySelector('audio'), null, 'the deleted track must not keep playing');
});

test('a delete the server refuses leaves the track in place and says so', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/file')) {
      return new Response(JSON.stringify({ error: 'Permission denied' }), { status: 403 });
    }
    if (url.includes('/api/file-tree/media/list')) {
      return new Response(JSON.stringify(TRACKS), { status: 200 });
    }
    return new Response(null, { status: 200 });
  }));

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  fireEvent.click(await findByText('song.flac'));
  await waitFor(() => assert.ok(container.querySelector('audio')));

  fireEvent.click(deleteButton(container));

  await findByText('Permission denied');
  assert.ok(await findByText('song.flac'), 'a refused delete must leave the track listed');
});
