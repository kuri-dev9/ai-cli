import { BellOff, ChevronDown, ChevronRight } from 'lucide-react';
import type { TFunction } from 'i18next';

type SidebarQuietProjectsHeaderProps = {
  projectCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  t: TFunction;
};

/**
 * 조용한 폴더 묶음의 머리글. 사이드바 프로젝트 목록 맨 아래에 하나만 그려진다.
 *
 * 사용자 그룹 머리글과 달리 이름 변경·이동·삭제·드롭이 없다. 이 묶음에 무엇이
 * 들어갈지는 경로 규칙(설정 > 모양)이 정하므로, 여기서는 펼치고 접기만 한다.
 */
export default function SidebarQuietProjectsHeader({
  projectCount,
  expanded,
  onToggleExpanded,
  t,
}: SidebarQuietProjectsHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggleExpanded}
      title={t('sidebar:quietFolders.hint', {
        defaultValue: 'Projects under quiet folders. Manage the folders in Settings > Appearance.',
      })}
      className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
    >
      {expanded ? (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <BellOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
        {t('sidebar:quietFolders.title', { defaultValue: 'Quiet folders' })}
      </span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/60">
        {projectCount}
      </span>
    </button>
  );
}
