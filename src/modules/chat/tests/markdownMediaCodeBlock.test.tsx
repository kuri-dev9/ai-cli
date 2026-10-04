import assert from 'node:assert/strict';

import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';

/**
 * Kept apart from markdownMediaReference.test.tsx: rendering fenced blocks (the
 * syntax highlighter) alongside several other renders in one file takes the
 * jsdom worker down, so the block cases live on their own.
 *
 * `opened` collects the paths the palette's file-open operation is handed,
 * which is how a block's play control reaches the media panel.
 */
const renderMarkdown = (markdown: string, opened: string[] = []) => {
  const Harness = () => {
    usePaletteOpsRegister({ openFileInEditor: (path: string) => opened.push(path) });
    return <Markdown>{markdown}</Markdown>;
  };

  return render(
    <PaletteOpsProvider>
      <Harness />
    </PaletteOpsProvider>,
  );
};

afterEach(() => {
  // Unmount properly: clearing innerHTML leaves the React root (and the syntax
  // highlighter it mounted) alive, and the leftovers take the worker down.
  cleanup();
});

test('a code block holding one playable path offers to play it', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown(
    '```bash\nopen ~/.soriforge/tracks/20261004-0956_같은-하늘-아래_94bpm_195s_ko.flac\n```',
    opened,
  );

  // The code stays a command: only the toolbar gains a control. The copy button
  // is always there, so a play control shows up as a second button.
  assert.ok(container.querySelector('pre'), 'the block must still render as code');
  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 2, 'a block with one track must offer to play it');

  fireEvent.click(buttons[0]);
  assert.deepEqual(opened, ['~/.soriforge/tracks/20261004-0956_같은-하늘-아래_94bpm_195s_ko.flac']);
});

test('a quoted path inside a command is found too', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown(
    '```bash\nafinfo "/Users/me/tracks/two words.flac"\n```',
    opened,
  );

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  fireEvent.click(buttons[0]);
  assert.deepEqual(opened, ['/Users/me/tracks/two words.flac']);
});

test('a block with no track, or with several, offers nothing', () => {
  const plain = renderMarkdown('```bash\nnpm run build\n```', []);
  assert.equal(plain.container.querySelectorAll('button').length, 1, 'copy only');
  cleanup();

  // Two tracks: there is no way to tell which one the button would play.
  const many = renderMarkdown(
    '```bash\ncp /Users/me/a.flac /Users/me/keep/b.flac\n```',
    [],
  );
  assert.equal(many.container.querySelectorAll('button').length, 1, 'copy only');
});
