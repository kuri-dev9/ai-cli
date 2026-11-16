import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Cell, Workbook, Worksheet } from 'exceljs';

type XlsxViewProps = {
  data: ArrayBuffer;
  onError: (error: unknown) => void;
  labels: {
    truncated: (rows: number, columns: number) => string;
    empty: string;
  };
};

// 화면에 그리는 범위. 이보다 큰 시트는 앞부분만 보여 주고 잘렸다고 알린다 —
// 칸 하나가 DOM 요소 하나라서 수십만 칸을 그리면 탭이 멈춘다.
const MAX_ROWS = 2000;
const MAX_COLUMNS = 200;

// Excel 의 열 너비 단위(기본 글꼴 문자 수)와 행 높이 단위(pt)를 px 로 바꾼다.
const DEFAULT_COLUMN_WIDTH_PX = 72;
const DEFAULT_ROW_HEIGHT_PX = 20;
const columnWidthPx = (width?: number) => (width ? Math.round(width * 7 + 5) : DEFAULT_COLUMN_WIDTH_PX);
const rowHeightPx = (height?: number) => (height ? Math.round(height * (96 / 72)) : DEFAULT_ROW_HEIGHT_PX);

const columnLetter = (index: number): string => {
  let n = index;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

// 'FFRRGGBB' → '#RRGGBB'. 테마 색(theme 번호)은 통합 문서 테마를 풀어야 해서 건너뛴다.
const argbToCss = (argb?: string): string | undefined => (
  argb && /^[0-9a-f]{8}$/i.test(argb) ? `#${argb.slice(2)}` : undefined
);

/** 병합 영역 'A1:C2' 를 시작 칸 주소 → 가로·세로 칸 수로 바꾼다. */
const parseMerges = (worksheet: Worksheet): Map<string, { rowSpan: number; colSpan: number }> => {
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  const merges = (worksheet.model as { merges?: string[] }).merges ?? [];
  for (const range of merges) {
    const [start, end] = range.split(':');
    if (!start || !end) continue;
    const startCell = worksheet.getCell(start);
    const endCell = worksheet.getCell(end);
    spans.set(startCell.address, {
      rowSpan: Number(endCell.row) - Number(startCell.row) + 1,
      colSpan: Number(endCell.col) - Number(startCell.col) + 1,
    });
  }
  return spans;
};

const cellStyle = (cell: Cell): CSSProperties => {
  const style: CSSProperties = {};
  const { font, fill, alignment } = cell;
  if (font?.bold) style.fontWeight = 600;
  if (font?.italic) style.fontStyle = 'italic';
  if (font?.underline) style.textDecoration = 'underline';
  const fontColor = argbToCss(font?.color?.argb);
  if (fontColor) style.color = fontColor;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const background = argbToCss(fill.fgColor?.argb);
    if (background) style.backgroundColor = background;
  }
  if (alignment?.horizontal && ['left', 'center', 'right'].includes(alignment.horizontal)) {
    style.textAlign = alignment.horizontal as CSSProperties['textAlign'];
  } else if (typeof cell.value === 'number') {
    style.textAlign = 'right';
  }
  if (alignment?.vertical === 'middle') style.verticalAlign = 'middle';
  else if (alignment?.vertical === 'bottom') style.verticalAlign = 'bottom';
  style.whiteSpace = alignment?.wrapText ? 'pre-wrap' : 'pre';
  return style;
};

const cellText = (cell: Cell): string => {
  try {
    return cell.text ?? '';
  } catch {
    return String(cell.value ?? '');
  }
};

function SheetTable({ worksheet, labels }: { worksheet: Worksheet; labels: XlsxViewProps['labels'] }) {
  const rowCount = Math.min(worksheet.rowCount, MAX_ROWS);
  const columnCount = Math.min(worksheet.columnCount, MAX_COLUMNS);
  const truncated = worksheet.rowCount > MAX_ROWS || worksheet.columnCount > MAX_COLUMNS;
  const merges = useMemo(() => parseMerges(worksheet), [worksheet]);

  if (rowCount === 0 || columnCount === 0) {
    return <p className="p-6 text-sm text-muted-foreground">{labels.empty}</p>;
  }

  const columns = Array.from({ length: columnCount }, (_, index) => index + 1);
  const rows = Array.from({ length: rowCount }, (_, index) => index + 1);

  return (
    <>
      {truncated && (
        <p className="sticky left-0 top-0 z-30 border-b border-amber-300 bg-amber-50 px-3 py-1 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          {labels.truncated(rowCount, columnCount)}
        </p>
      )}
      {/* 시트는 문서처럼 늘 흰 바탕에 검은 글자다. 셀 색이 그 위를 전제로 정해져 있다. */}
      <table className="border-separate border-spacing-0 bg-[#ffffff] text-[12px] text-[#1f1f1f]" style={{ tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: 44 }} />
          {columns.map((column) => (
            <col key={column} style={{ width: columnWidthPx(worksheet.getColumn(column).width) }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 border-b border-r border-[#d0d0d0] bg-[#f3f3f3]" />
            {columns.map((column) => (
              <th
                key={column}
                className="sticky top-0 z-10 border-b border-r border-[#d0d0d0] bg-[#f3f3f3] px-1 font-normal text-[#555]"
              >
                {columnLetter(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((rowNumber) => {
            const row = worksheet.getRow(rowNumber);
            return (
              <tr key={rowNumber} style={{ height: rowHeightPx(row.height) }}>
                <th className="sticky left-0 z-10 border-b border-r border-[#d0d0d0] bg-[#f3f3f3] px-1 text-right font-normal text-[#555]">
                  {rowNumber}
                </th>
                {columns.map((column) => {
                  const cell = row.getCell(column);
                  // 병합 영역의 시작 칸만 그린다. 나머지는 시작 칸이 덮는다.
                  if (cell.isMerged && cell.master.address !== cell.address) {
                    return null;
                  }
                  const span = merges.get(cell.address);
                  return (
                    <td
                      key={column}
                      rowSpan={span?.rowSpan}
                      colSpan={span?.colSpan}
                      title={cell.formula ? `=${cell.formula}` : undefined}
                      className="overflow-hidden border-b border-r border-[#e2e2e2] px-1 align-bottom"
                      style={cellStyle(cell)}
                    >
                      {cellText(cell)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/**
 * .xlsx 를 엑셀처럼 칸·병합·열 너비·글꼴·채우기 색까지 살려 그린다(exceljs).
 * 아래쪽 탭으로 시트를 바꾼다. 라이브러리는 이 화면을 열 때만 불러온다.
 */
export default function XlsxView({ data, onError, labels }: XlsxViewProps) {
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ExcelJS = await import('exceljs');
        const WorkbookClass = (ExcelJS.default ?? ExcelJS).Workbook;
        const next = new WorkbookClass();
        await next.xlsx.load(data);
        if (cancelled) return;
        setWorkbook(next);
        // 다시 읽어도(새로고침) 보던 시트에 머문다. 시트가 줄었으면 첫 시트로.
        setActiveSheet((current) => (current < next.worksheets.length ? current : 0));
      } catch (error) {
        if (!cancelled) onError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, onError]);

  if (!workbook) {
    return null;
  }

  const sheets = workbook.worksheets.filter((sheet) => sheet.state !== 'veryHidden');
  const worksheet = sheets[activeSheet] ?? sheets[0];

  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-[#ffffff]">
        {worksheet ? <SheetTable key={worksheet.id} worksheet={worksheet} labels={labels} /> : (
          <p className="p-6 text-sm text-muted-foreground">{labels.empty}</p>
        )}
      </div>
      {sheets.length > 1 && (
        <div className="flex flex-shrink-0 gap-0.5 overflow-x-auto border-t border-border bg-muted/50 px-2 py-1">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.id}
              type="button"
              onClick={() => setActiveSheet(index)}
              className={`whitespace-nowrap rounded px-2.5 py-1 text-xs transition-colors ${
                sheet === worksheet
                  ? 'bg-card font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              } ${sheet.state === 'hidden' ? 'italic opacity-60' : ''}`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
