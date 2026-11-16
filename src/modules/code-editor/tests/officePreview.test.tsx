import assert from 'node:assert/strict';

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { afterEach, test, vi } from 'vitest';

import CodeEditorOfficePreview from '@/modules/code-editor/office/CodeEditorOfficePreview';
import { getOfficeKind, isViewableFile } from '@/modules/code-editor/utils/previewableFile';
import { api } from '@/shared/api';

/**
 * Word·Excel 문서를 텍스트 에디터의 "바이너리 파일" 안내 대신 실제 문서
 * 모양으로 보여 준다. 여기서는 진짜 .docx·.xlsx 바이트를 만들어 그려 본다.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const LABELS = {
  loading: 'loading',
  error: 'error',
  refresh: 'refresh',
  close: 'close',
  sheetTruncated: (rows: number, columns: number) => `truncated ${rows}x${columns}`,
  sheetEmpty: 'empty',
};

const serveBytes = (bytes: Uint8Array | ArrayBuffer) => {
  vi.spyOn(api, 'readFileBlob').mockImplementation(async () => new Response(new Uint8Array(bytes)));
};

async function buildDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>장애 대응 가이드</w:t></w:r></w:p>
    <w:p><w:r><w:t>프로브 패키지 설치 순서</w:t></w:r></w:p>
  </w:body>
</w:document>`);
  return zip.generateAsync({ type: 'uint8array' });
}

async function buildXlsx(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('월별');
  sheet.getCell('A1').value = '작업자';
  sheet.getCell('A1').font = { bold: true };
  sheet.getCell('B1').value = '시간';
  sheet.getCell('A2').value = '홍길동';
  sheet.getCell('B2').value = 12.5;
  sheet.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };
  sheet.mergeCells('A4:B4');
  sheet.getCell('A4').value = '합계';
  workbook.addWorksheet('달력').getCell('A1').value = '정기';
  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}

test('Word·Excel 확장자를 알아보고 보기 단추 대상에 넣는다', () => {
  assert.equal(getOfficeKind('output/Probe_설치_가이드_v1.4.docx'), 'docx');
  assert.equal(getOfficeKind('report.xlsx'), 'xlsx');
  assert.equal(getOfficeKind('macro.xlsm'), 'xlsx');
  assert.equal(getOfficeKind('old.doc'), null);
  assert.equal(isViewableFile('output/Probe_장애_대응_가이드_v1.0.docx'), true);
  assert.equal(isViewableFile('report.xlsx'), true);
});

test('.docx 는 문서 페이지로 그려진다', async () => {
  serveBytes(await buildDocx());
  const { container } = render(
    <CodeEditorOfficePreview
      file={{ name: 'guide.docx', path: 'output/guide.docx', projectId: 'p' }}
      kind="docx"
      projectId="p"
      isSidebar
      onClose={() => {}}
      labels={LABELS}
    />,
  );

  // 앱 CSS 가 문서 서식을 덮지 않도록 따로 떨어진 iframe 문서에 그린다.
  const frameDocument = () => container.querySelector('iframe')?.contentDocument ?? null;
  await waitFor(() => assert.ok(frameDocument()?.querySelector('section.docx'), 'Word 페이지가 그려져야 한다'));
  assert.equal(container.querySelector('section.docx'), null, '앱 문서에는 그리지 않는다');
  const text = frameDocument()?.body.textContent ?? '';
  assert.match(text, /장애 대응 가이드/);
  assert.match(text, /프로브 패키지 설치 순서/);
  // Windows 한글 글꼴을 이 컴퓨터 글꼴로 잇는 별칭이 들어 있다.
  assert.match(frameDocument()?.head.innerHTML ?? '', /font-family: "맑은 고딕"/);
});

test('.xlsx 는 칸·서식·병합·시트 탭을 살려 그린다', async () => {
  serveBytes(await buildXlsx());
  const { container } = render(
    <CodeEditorOfficePreview
      file={{ name: 'kpi.xlsx', path: 'kpi.xlsx', projectId: 'p' }}
      kind="xlsx"
      projectId="p"
      isSidebar
      onClose={() => {}}
      labels={LABELS}
    />,
  );

  await screen.findByText('홍길동');
  const header = screen.getByText('작업자');
  assert.equal(header.style.fontWeight, '600');
  assert.equal(screen.getByText('홍길동').style.backgroundColor, 'rgb(255, 235, 156)');
  assert.equal(screen.getByText('12.5').style.textAlign, 'right');
  assert.equal(screen.getByText('합계').getAttribute('colspan'), '2');
  // 열 머리글은 엑셀처럼 A, B …
  assert.ok([...container.querySelectorAll('thead th')].some((th) => th.textContent === 'B'));

  fireEvent.click(screen.getByRole('button', { name: '달력' }));
  await screen.findByText('정기');
});

test('읽지 못하면 오류와 경로를 보여 준다', async () => {
  vi.spyOn(api, 'readFileBlob').mockImplementation(async () => new Response('nope', { status: 404 }));
  render(
    <CodeEditorOfficePreview
      file={{ name: 'missing.docx', path: 'missing.docx', projectId: 'p' }}
      kind="docx"
      projectId="p"
      isSidebar
      onClose={() => {}}
      labels={LABELS}
    />,
  );

  await screen.findByText('error');
  // 머리글의 파일 이름과 본문의 경로, 두 곳에 나온다.
  assert.equal(screen.getAllByText('missing.docx').length, 2);
});
