import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePaletteOps } from '@/modules/command-palette';
import { copyTextToClipboard } from '@/shared/utils';

// 글을 읽느라 지나가는 마우스에는 뜨지 않고, 이름 위에 잠시 머물 때만 연다.
const OPEN_DELAY_MS = 400;
// 이름에서 메뉴로 마우스를 옮기는 사이 닫히지 않을 만큼만 기다린다.
const CLOSE_DELAY_MS = 150;

type FileReferenceMenuProps = {
  /** 열고 복사할 경로. 줄 번호(`:12`)는 이미 뗀 값이다. */
  filePath: string;
  children: ReactNode;
};

/**
 * 답변 속 파일 이름(인라인 코드). 위에 잠시 마우스를 올리거나 누르면 바로 아래에
 * [보기] [경로 복사] 메뉴가 뜬다. 이름마다 단추를 늘어놓으면 `a.png`, `.svg`, `.py`
 * 처럼 붙어 있는 이름 사이가 단추로 어지러워져서 필요할 때만 꺼낸다.
 */
export function FileReferenceMenu({ filePath, children }: FileReferenceMenuProps) {
  const { t } = useTranslation('chat');
  const { openDocument } = usePaletteOps();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const show = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // 이름 바로 아래에 붙인다. 화면 아래가 모자라면 위로 띄운다.
    const placeAbove = rect.bottom + 44 > window.innerHeight;
    setMenuStyle({
      position: 'fixed',
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 220)),
      top: placeAbove ? rect.top - 4 : rect.bottom + 4,
      transform: placeAbove ? 'translateY(-100%)' : undefined,
      zIndex: 9999,
    });
    setCopied(false);
    setOpen(true);
  }, []);

  const scheduleOpen = () => {
    clearTimer();
    timerRef.current = window.setTimeout(show, OPEN_DELAY_MS);
  };

  const scheduleClose = () => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  useEffect(() => clearTimer, []);

  // 스크롤하거나 Esc 를 누르면 닫는다. 떠 있는 메뉴가 이름에서 떨어져 남지 않게 한다.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const viewLabel = t('codeBlock.viewDocument');
  const copyLabel = copied ? t('codeBlock.copied') : t('codeBlock.copyPath');
  const itemClassName =
    'inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent';

  return (
    <>
      <span
        ref={anchorRef}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={filePath}
        className="cursor-pointer decoration-dotted underline-offset-2 hover:underline"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onClick={() => {
          clearTimer();
          if (open) setOpen(false);
          else show();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            show();
          }
        }}
      >
        {children}
      </span>
      {open && menuStyle && createPortal(
        <div
          role="menu"
          style={menuStyle}
          onMouseEnter={clearTimer}
          onMouseLeave={scheduleClose}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            className={itemClassName}
            onClick={() => {
              setOpen(false);
              openDocument(filePath);
            }}
          >
            <Eye aria-hidden="true" className="h-3.5 w-3.5" />
            {viewLabel}
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClassName}
            onClick={() => {
              void copyTextToClipboard(filePath).then((success) => {
                if (success) setCopied(true);
              });
            }}
          >
            {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5 text-green-600" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
            {copyLabel}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
