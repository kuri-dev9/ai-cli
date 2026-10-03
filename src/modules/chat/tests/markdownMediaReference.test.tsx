import assert from 'node:assert/strict';

import { render, fireEvent } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';

/**
 * Renders markdown inside the real palette-ops registry, so a click travels the
 * same path it does in the app: the play button calls `openFileInEditor`, which
 * is what opens the file in the editor and its media preview.
 */
const renderMarkdown = (markdown: string) => {
  const opened: string[] = [];

  const Harness = () => {
    usePaletteOpsRegister({ openFileInEditor: (path: string) => opened.push(path) });
    return <Markdown>{markdown}</Markdown>;
  };

  const { container } = render(
    <PaletteOpsProvider>
      <Harness />
    </PaletteOpsProvider>,
  );

  return { container, opened };
};

afterEach(() => {
  document.body.innerHTML = '';
});

test('an inline-code audio path renders as a play button that opens the file', () => {
  const track = '/Users/me/.soriforge/tracks/7079962e-84c6-4666-8290-c7c3baf82e66-0.flac';
  const { container, opened } = renderMarkdown(`파일: \`${track}\` (4.3MB, FLAC)`);

  const button = container.querySelector('button');
  assert.ok(button, 'a playable path must be actionable');
  assert.equal(button.textContent?.includes(track), true);

  fireEvent.click(button);
  assert.deepEqual(opened, [track]);
});

test('video paths and ~-relative paths are playable too', () => {
  for (const reference of ['/Users/me/clips/demo.mp4', '~/.soriforge/tracks/song.flac']) {
    const { container, opened } = renderMarkdown(`\`${reference}\``);
    const button = container.querySelector('button');
    assert.ok(button, `${reference} must be actionable`);
    fireEvent.click(button);
    assert.deepEqual(opened, [reference]);
    document.body.innerHTML = '';
  }
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
