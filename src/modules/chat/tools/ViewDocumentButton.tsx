import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';

import { usePaletteOps } from '@/modules/command-palette';

type ViewDocumentButtonProps = {
  filePath: string;
};

/**
 * 채팅에 나온 문서·소스 파일 옆에 붙는 "보기" 단추. 누르면 대화 오른쪽에 열리고
 * (마크다운·HTML 은 미리보기로), Claude 가 그 파일을 고치면 따라 갱신된다.
 */
export function ViewDocumentButton({ filePath }: ViewDocumentButtonProps) {
  const { t } = useTranslation('chat');
  const { openDocument } = usePaletteOps();
  const label = t('codeBlock.viewDocument');

  return (
    <button
      type="button"
      onClick={(event) => {
        // 도구 카드 제목 안에 있을 때 카드가 함께 펼쳐지지 않게 한다.
        event.stopPropagation();
        openDocument(filePath);
      }}
      className="ml-1 inline-flex items-center gap-0.5 rounded-md border border-border/70 px-1.5 py-0.5 align-middle font-sans text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title={`${label}: ${filePath}`}
      aria-label={`${label}: ${filePath}`}
    >
      <Eye aria-hidden="true" className="h-3 w-3" />
      {label}
    </button>
  );
}
