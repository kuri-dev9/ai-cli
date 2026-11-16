import { useEffect, useRef, useState } from 'react';

type DocxViewProps = {
  data: ArrayBuffer;
  /** 그리다 실패했을 때 바깥에 알린다. */
  onError: (error: unknown) => void;
};

// docx-preview 가 그리는 페이지는 실제 용지 폭(A4 ≈ 794px)이다. 패널이 그보다
// 좁으면 가로 스크롤이 생기므로 패널 폭에 맞춰 줄인다. 키우지는 않는다.
const PAGE_GUTTER_PX = 24;

// docx-preview 는 그린 뒤 500ms 에 화면 좌표를 재서 탭(목차 점선 등)의 폭을
// 정한다. 그 전에 배율을 바꾸면 줄어든 좌표로 재서 목차 줄이 갈라진다.
// 탭 계산이 끝난 뒤에 배율을 맞추고, 그때까지는 문서를 가려 둔다.
const TAB_LAYOUT_SETTLE_MS = 650;

/**
 * Windows 문서에 흔한 한글 글꼴을 이 컴퓨터에 있는 글꼴로 잇는다. 그 글꼴이
 * 실제로 깔려 있으면(Windows) 그것을 먼저 쓴다. 없는 글꼴은 브라우저가 아무
 * 기본 글꼴로 바꿔 그려서 글자 폭과 줄바꿈이 원본과 크게 달라진다.
 */
const KOREAN_FONT_ALIASES: Array<{ names: string[]; regular: string[]; bold: string[] }> = [
  {
    names: ['맑은 고딕', 'Malgun Gothic', '굴림', 'Gulim', '굴림체', 'GulimChe', '돋움', 'Dotum', '돋움체', 'DotumChe', '나눔고딕', 'NanumGothic'],
    regular: ['Apple SD Gothic Neo', 'AppleSDGothicNeo-Regular', 'Noto Sans KR', 'Noto Sans CJK KR'],
    bold: ['AppleSDGothicNeo-Bold', 'Apple SD Gothic Neo Bold', 'Noto Sans KR Bold'],
  },
  {
    names: ['바탕', 'Batang', '바탕체', 'BatangChe', '궁서', 'Gungsuh', '나눔명조', 'NanumMyeongjo'],
    regular: ['AppleMyungjo', 'Noto Serif KR', 'Noto Serif CJK KR'],
    bold: ['AppleMyungjo', 'Noto Serif KR Bold'],
  },
];

const fontAliasCss = (): string => KOREAN_FONT_ALIASES.flatMap(({ names, regular, bold }) => names.flatMap((name) => {
  const sources = (fallbacks: string[]) => [name, ...fallbacks].map((font) => `local("${font}")`).join(', ');
  return [
    `@font-face { font-family: "${name}"; src: ${sources(regular)}; font-weight: 100 599; }`,
    `@font-face { font-family: "${name}"; src: ${sources(bold)}; font-weight: 600 900; }`,
  ];
})).join('\n');

const frameDocumentHtml = (isDark: boolean) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
${fontAliasCss()}
html, body { margin: 0; padding: 0; }
body { background: ${isDark ? '#2a2927' : '#e4e0d8'}; }
.docx-wrapper { background: transparent !important; padding: 12px !important; }
section.docx { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18) !important; margin-bottom: 12px !important; }
</style></head><body><div id="docx-styles"></div><div id="docx-body"></div></body></html>`;

/**
 * .docx 를 Word 페이지 모양으로 그린다(docx-preview). 글꼴·표·머리글·바닥글·
 * 그림까지 살린다. 앱의 CSS(목록·이미지·링크 초기화 등)가 문서 서식을 덮지
 * 않도록 따로 떨어진 iframe 문서에 그린다. 라이브러리는 이 화면을 열 때만 불러온다.
 */
export default function DocxView({ data, onError }: DocxViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [laidOut, setLaidOut] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    const frameDocument = frame?.contentDocument;
    if (!frame || !frameDocument) {
      return undefined;
    }

    let cancelled = false;
    let settleTimer: number | null = null;
    setLaidOut(false);

    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        frameDocument.open();
        frameDocument.write(frameDocumentHtml(document.documentElement.classList.contains('dark')));
        frameDocument.close();
        // docx-preview 는 넘겨받은 칸을 비우고 시작한다. head 를 넘기면 위의 글꼴
        // 별칭까지 지워지므로 따로 마련한 칸을 넘긴다.
        const bodyContainer = frameDocument.getElementById('docx-body');
        const styleContainer = frameDocument.getElementById('docx-styles');
        if (!bodyContainer || !styleContainer) return;
        await renderAsync(data, bodyContainer, styleContainer, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true,
          useBase64URL: true,
          // 문서에 박힌 HTML 조각(altChunk)은 iframe 으로 그려져 스크립트가 돌 수 있다.
          renderAltChunks: false,
        });
        if (cancelled) return;
        // 문서 속 링크는 새 탭으로만 열고, 스크립트 주소는 막는다. 목차 같은 문서 안
        // 이동(#)은 이 iframe 안에서 스크롤한다.
        frameDocument.querySelectorAll('a[href]').forEach((anchor) => {
          const href = anchor.getAttribute('href') ?? '';
          if (/^\s*(javascript|data|vbscript):/i.test(href)) {
            anchor.removeAttribute('href');
            return;
          }
          if (!href.startsWith('#')) {
            anchor.setAttribute('target', '_blank');
            anchor.setAttribute('rel', 'noopener noreferrer');
          }
        });
        settleTimer = window.setTimeout(() => {
          if (!cancelled) setLaidOut(true);
        }, TAB_LAYOUT_SETTLE_MS);
      } catch (error) {
        if (!cancelled) onError(error);
      }
    })();

    return () => {
      cancelled = true;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [data, onError]);

  // 탭 계산이 끝난 뒤, 그리고 패널 폭이 바뀔 때마다 페이지 배율을 맞춘다.
  // 이미 정해진 탭 폭은 pt 단위라 배율이 바뀌어도 함께 줄어든다.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !laidOut) {
      return undefined;
    }

    const fit = () => {
      const body = frame.contentDocument?.body;
      const page = body?.querySelector<HTMLElement>('section.docx');
      if (!body || !page) return;
      body.style.setProperty('zoom', '');
      const scale = Math.min(1, (frame.clientWidth - PAGE_GUTTER_PX) / page.offsetWidth);
      body.style.setProperty('zoom', scale < 1 ? String(scale) : '');
    };

    fit();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [laidOut]);

  return (
    <iframe
      ref={frameRef}
      title="docx"
      // 탭 폭을 재는 동안에는 줄어들기 전 모양이 잠깐 비치지 않게 가린다.
      className={`h-full w-full border-0 transition-opacity duration-150 ${laidOut ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}
