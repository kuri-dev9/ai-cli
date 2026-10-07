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

test('a connected folder lists its tracks and plays the chosen one at the bottom', async () => {
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
    assert.ok(audio, 'clicking an entry loads the player');
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

test('a file opened from outside plays in the same bottom player', async () => {
  const { container } = render(
    <MediaLibraryPanel
      projectId={PROJECT}
      openedFilePath="/Users/me/Music/tracks/new.flac"
      onClose={() => undefined}
    />,
  );

  await waitFor(() => {
    const audio = container.querySelector('audio');
    assert.ok(audio, 'the file the workspace opened plays without being in a folder');
    assert.equal(container.querySelectorAll('audio').length, 1, 'only one player exists');
    const src = new URL(audio.getAttribute('src') ?? '', 'http://localhost');
    assert.equal(src.searchParams.get('path'), '/Users/me/Music/tracks/new.flac');
  });
});

/** 폴더 머리글 버튼. 라벨이 전체 경로라 텍스트 대신 구조로 찾는다. */
const folderHeader = (container: HTMLElement) => {
  const header = container.querySelector('section > button');
  assert.ok(header, 'a connected folder must have a header');
  return header;
};

/** 행 오른쪽의 연필 — 수정 창을 연다. 라벨은 환경마다 달라 자리로 찾는다. */
const editButton = (container: HTMLElement) => {
  const entry = container.querySelector('li');
  assert.ok(entry);
  const buttons = entry.querySelectorAll('button');
  return buttons[buttons.length - 1];
};

/** 수정 창 맨 아래 줄의 버튼들 — 삭제 · 취소 · 저장 순이다. */
const editModalActions = (container: HTMLElement) => {
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog, 'the edit modal must be open');
  const footer = dialog.lastElementChild;
  assert.ok(footer);
  return Array.from(footer.querySelectorAll('button'));
};

/** 수정 창을 연다. 바뀐 파일 작업은 모두 이 창 안에 있다. */
const openEditModal = async (container: HTMLElement) => {
  fireEvent.click(editButton(container));
  await waitFor(() => assert.ok(container.querySelector('[role="dialog"]')));
};

/** 하단 플레이어 위의 제목 줄. 목록 행이 아니라 플레이어 블록 안에 있다. */
const nowPlayingTitle = (container: HTMLElement) => {
  const audio = container.querySelector('audio');
  assert.ok(audio, 'a player must be loaded');
  return audio.closest('div.shrink-0')?.querySelector('p');
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

test('choosing another track replaces the one playing instead of stacking', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  fireEvent.click(await findByText('song.flac'));
  await waitFor(() => assert.ok(container.querySelector('audio')));

  fireEvent.click(await findByText('another.flac'));

  // 행마다 플레이어를 펼치던 시절에는 두 곡이 같이 울렸고, 곡이 끝나면 어느
  // 플레이어가 무엇이었는지 알 수 없었다. 이제 플레이어는 하나뿐이다.
  await waitFor(() => {
    const players = container.querySelectorAll('audio');
    assert.equal(players.length, 1, 'only one track can play at a time');
    const src = new URL(players[0].getAttribute('src') ?? '', 'http://localhost');
    assert.equal(src.searchParams.get('path'), '/Users/me/tracks/another.flac');
  });

  // 플레이어 위에 제목이 있으니 무엇이 울리는지 눈으로 확인할 수 있다.
  const title = nowPlayingTitle(container);
  assert.equal(title?.textContent, 'another.flac');
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

test('deleting a track from the edit window asks first, then removes it and its player', async () => {
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

  await openEditModal(container);
  fireEvent.click(editModalActions(container)[0]);

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

  await openEditModal(container);
  fireEvent.click(editModalActions(container)[0]);

  // The window that asked for the delete is the one that says why it failed,
  // and it stays open so the next attempt starts from there.
  await findByText('Permission denied');
  assert.ok(container.querySelector('[role="dialog"]'));
  assert.ok(listedNames(container).includes('song.flac'), 'a refused delete must leave the track listed');
});

test('the edit window renames a track in place and closes', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks', '/Users/me/keep']);
  const moveCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/move')) {
      moveCalls.push(String(init?.body));
      return new Response(JSON.stringify({ success: true, path: '/Users/me/tracks/take 2.flac' }), { status: 200 });
    }
    if (url.includes('/api/file-tree/media/list')) {
      // Only the first folder holds anything, so each name is listed once.
      return new Response(
        JSON.stringify(url.includes('keep') ? { files: [] } : TRACKS),
        { status: 200 },
      );
    }
    return new Response(null, { status: 200 });
  }));

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await findByText('song.flac');
  await openEditModal(container);

  const nameField = container.querySelector('#media-file-name') as HTMLInputElement;
  assert.ok(nameField);
  assert.equal(nameField.value, 'song.flac', 'the field starts at the name the file has');
  fireEvent.change(nameField, { target: { value: 'take 2.flac' } });

  // 삭제 · 취소 · 저장 중 저장.
  fireEvent.click(editModalActions(container)[2]);

  await waitFor(() => assert.equal(moveCalls.length, 1));
  const sent = JSON.parse(moveCalls[0]) as { path: string; name?: string; targetFolder?: string };
  assert.equal(sent.path, '/Users/me/tracks/song.flac');
  assert.equal(sent.name, 'take 2.flac');
  // Nothing was dragged anywhere, so the folder must be left out entirely.
  assert.equal(sent.targetFolder, null);
  await waitFor(() => assert.equal(container.querySelector('[role="dialog"]'), null));
});

test('dropping a track on another folder moves it there', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks', '/Users/me/keep']);
  const moveCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/move')) {
      moveCalls.push(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('/api/file-tree/media/list')) {
      // Only the first folder holds anything; the second is where things go.
      return new Response(
        JSON.stringify(url.includes('keep') ? { files: [] } : TRACKS),
        { status: 200 },
      );
    }
    return new Response(null, { status: 200 });
  }));

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await findByText('song.flac');
  const [tracksSection, keepSection] = Array.from(container.querySelectorAll('section'));
  assert.ok(tracksSection && keepSection);
  const row = tracksSection.querySelector('li');
  assert.ok(row);

  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => undefined, getData: () => '' };
  fireEvent.dragStart(row, { dataTransfer });
  fireEvent.dragOver(keepSection, { dataTransfer });
  fireEvent.drop(keepSection, { dataTransfer });

  await waitFor(() => assert.equal(moveCalls.length, 1));
  const sent = JSON.parse(moveCalls[0]) as { path: string; targetFolder?: string };
  assert.equal(sent.path, '/Users/me/tracks/song.flac');
  assert.equal(sent.targetFolder, '/Users/me/keep');
});

test('a track cannot be dropped back on the folder it came from', async () => {
  writeMediaFolders(PROJECT, ['/Users/me/tracks']);
  const moveCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/move')) {
      moveCalls.push(String(init?.body));
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes('/api/file-tree/media/list')) {
      return new Response(JSON.stringify(TRACKS), { status: 200 });
    }
    return new Response(null, { status: 200 });
  }));

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await findByText('song.flac');
  const section = container.querySelector('section');
  assert.ok(section);
  const row = section.querySelector('li');
  assert.ok(row);

  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => undefined, getData: () => '' };
  fireEvent.dragStart(row, { dataTransfer });
  fireEvent.drop(section, { dataTransfer });

  // A move onto itself is a request the server would answer with a 409, so the
  // panel does not make it at all.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(moveCalls, []);
});

test('converting asks where to save, and keeps the result out of a hidden folder', async () => {
  // A file generated into `~/.cache/tracks` cannot be reached in Finder, so
  // the window has to offer somewhere else before it writes anything.
  writeMediaFolders(PROJECT, ['/Users/me/.cache/tracks', '/Users/me/Music']);
  const hidden = {
    name: 'song.flac',
    path: '/Users/me/.cache/tracks/song.flac',
    relativePath: 'song.flac',
    size: 4300000,
    modifiedAt: '2026-10-03T10:00:00.000Z',
    contentType: 'audio/flac',
  };
  const transcodeCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/file-tree/media/capabilities')) {
      return new Response(JSON.stringify({ transcode: true, formats: ['mp3', 'mp4'] }), { status: 200 });
    }
    if (url.includes('/api/file-tree/media/transcode')) {
      transcodeCalls.push(String(init?.body));
      return new Response(JSON.stringify({ success: true, path: '/Users/me/Music/song.mp4' }), { status: 200 });
    }
    if (url.includes('/api/file-tree/media/list')) {
      return new Response(
        JSON.stringify(url.includes('Music') ? { files: [] } : { files: [hidden] }),
        { status: 200 },
      );
    }
    return new Response(null, { status: 200 });
  }));

  const { container, findByText } = render(
    <MediaLibraryPanel projectId={PROJECT} openedFilePath={null} onClose={() => undefined} />,
  );

  await findByText('song.flac');
  await openEditModal(container);

  // 변환 화면은 본문 맨 아래 버튼으로 연다. 라벨은 환경마다 달라 자리로 찾는다.
  const dialog = container.querySelector('[role="dialog"]');
  assert.ok(dialog);
  const body = dialog.children[1];
  assert.ok(body);
  const bodyButtons = body.querySelectorAll('button');
  fireEvent.click(bodyButtons[bodyButtons.length - 1]);

  const folderField = await waitFor(() => {
    const field = dialog.querySelector('input[placeholder="/path/to/project/workspace"]') as HTMLInputElement;
    assert.ok(field);
    return field;
  });
  // The hidden folder the track came from must not be what it offers.
  assert.equal(folderField.value, '/Users/me/Music');

  const nameField = container.querySelector('#media-convert-name') as HTMLInputElement;
  assert.ok(nameField);
  assert.equal(nameField.value, 'song.mp4', 'the name follows the chosen format');

  // 뒤로 · 취소 · 변환 중 변환.
  const actions = editModalActions(container);
  fireEvent.click(actions[actions.length - 1]);

  await waitFor(() => assert.equal(transcodeCalls.length, 1));
  const sent = JSON.parse(transcodeCalls[0]) as {
    path: string; format: string; targetFolder: string; name: string;
  };
  assert.deepEqual(sent, {
    path: '/Users/me/.cache/tracks/song.flac',
    format: 'mp4',
    targetFolder: '/Users/me/Music',
    name: 'song.mp4',
  });

  // The original is untouched, so the window stays open and says where it went.
  await findByText('/Users/me/Music/song.mp4', { exact: false });
});
