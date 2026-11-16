import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import { PaletteOpsProvider, usePaletteOpsRegister } from '@/modules/command-palette';

/**
 * 답변 속 파일 이름은 그 자리에 단추를 늘어놓지 않는다. 이름 위에 잠시 머물거나
 * 누르면 [보기] [경로 복사] 메뉴가 뜬다. 예전에는 `a.png`, `.svg`, `.py` 처럼
 * 이어진 이름 중 마지막 하나에만 단추가 붙어 어느 파일 것인지 헷갈렸다.
 */

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** `opened` 는 "보기" 가 문서 열기 동작에 넘긴 경로를 모은다. */
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

/** 메뉴를 여는 파일 이름들. 글자 순서대로. */
const fileReferences = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[aria-haspopup="menu"]')];

const openAndView = (reference: HTMLElement) => {
  fireEvent.click(reference);
  fireEvent.click(screen.getByRole('menuitem', { name: /codeBlock.viewDocument|보기|View/ }));
};

test('이름 옆에 단추를 늘어놓지 않는다', () => {
  const { container } = renderMarkdown('v0.5로 올렸습니다(`Probe_장애대응_가이드_초안.md`).');

  assert.equal(container.querySelector('button'), null);
  assert.equal(fileReferences(container).length, 1);
});

test('이름 위에 잠시 머물면 메뉴가 뜨고, 보기를 누르면 그 파일을 연다', () => {
  vi.useFakeTimers();
  const opened: string[] = [];
  const { container } = renderMarkdown('`output/Probe_장애_대응_가이드_v1.0.docx` 를 새로 만들었습니다.', opened);
  const [reference] = fileReferences(container);

  fireEvent.mouseEnter(reference);
  assert.equal(screen.queryByRole('menu'), null, '지나가는 마우스에는 바로 뜨지 않는다');
  act(() => {
    vi.advanceTimersByTime(400);
  });
  screen.getByRole('menu');

  fireEvent.click(screen.getAllByRole('menuitem')[0]);
  assert.deepEqual(opened, ['output/Probe_장애_대응_가이드_v1.0.docx']);
  assert.equal(screen.queryByRole('menu'), null);
});

test('이어진 이름은 각자 자기 파일을 연다. 확장자만 적힌 줄임말은 파일이 아니다', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown(
    '그림을 새로 디자인해 `fig_packet_flow.png`, `.svg`, `.py` 를 덮어썼습니다. `images/` 밖은 그대로입니다.',
    opened,
  );

  const references = fileReferences(container);
  assert.deepEqual(references.map((reference) => reference.textContent), ['fig_packet_flow.png']);
  openAndView(references[0]);
  assert.deepEqual(opened, ['fig_packet_flow.png']);
});

test('줄 번호는 떼고, 소스·문서·이미지 파일 모두 메뉴를 단다', () => {
  const opened: string[] = [];
  const { container } = renderMarkdown(
    '`docs/guide.html:12` `apps-script/Code.gs` `scripts/build_docx.py` `report.xlsx` `Dockerfile`',
    opened,
  );

  for (const reference of fileReferences(container)) {
    openAndView(reference);
  }
  assert.deepEqual(opened, ['docs/guide.html', 'apps-script/Code.gs', 'scripts/build_docx.py', 'report.xlsx', 'Dockerfile']);
});

test('명령·와일드카드·URL·점이 든 코드 이름·버전에는 달지 않는다', () => {
  const { container } = renderMarkdown(
    '`cat README.md` `*.md` `https://example.com/a.html` `chrome://extensions` '
      + '`api.renameProject` `process.env` `v0.2.0` `N건 · X.Xh` `weekly` `.py`',
  );

  assert.equal(fileReferences(container).length, 0);
});
