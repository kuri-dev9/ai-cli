import assert from 'node:assert/strict';

import { render, fireEvent } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';

afterEach(() => {
  document.body.innerHTML = '';
});

/** `opened` 는 "보기" 단추가 문서 열기 동작에 넘긴 경로를 모은다. */
const renderMarkdown = (markdown: string, opened: string[] = []) => {
  const Harness = () => {
    usePaletteOpsRegister({ openDocument: (path: string) => opened.push(path) });
    return <Markdown>{markdown}</Markdown>;
  };

  return render(
    <PaletteOpsProvider>
      <Harness />
    </PaletteOpsProvider>,
  );
};

test('문서 파일 이름 옆에 보기 단추가 붙고, 누르면 그 문서를 연다', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown('v0.5로 올렸습니다(`Probe_장애대응_가이드_초안.md`).', opened);

  const button = container.querySelector('button');
  assert.ok(button, '문서 이름에는 보기 단추가 있어야 한다');

  fireEvent.click(button);
  assert.deepEqual(opened, ['Probe_장애대응_가이드_초안.md']);
});

test('줄 번호는 떼고, HTML·텍스트 문서에도 붙는다', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown('`docs/guide.html:12` 와 `notes.txt`', opened);

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  buttons.forEach((button) => fireEvent.click(button));
  assert.deepEqual(opened, ['docs/guide.html', 'notes.txt']);
});

test('Code.gs 같은 소스 파일에도 붙는다', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown(
    '`apps-script/Code.gs` 를 붙여 넣고, `Code.gs` 맨 위 `HOLIDAYS` 를 고칩니다. `fb_install.sh` `Dockerfile`',
    opened,
  );

  container.querySelectorAll('button').forEach((button) => fireEvent.click(button));
  assert.deepEqual(opened, ['apps-script/Code.gs', 'Code.gs', 'fb_install.sh', 'Dockerfile']);
});

test('명령·와일드카드·URL·점이 든 코드 이름·버전에는 붙지 않는다', () => {
  const { container } = renderMarkdown(
    '`cat README.md` `*.md` `https://example.com/a.html` `chrome://extensions` '
      + '`api.renameProject` `process.env` `v0.2.0` `N건 · X.Xh` `weekly`',
  );

  assert.equal(container.querySelector('button'), null);
});
