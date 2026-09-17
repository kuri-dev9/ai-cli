import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';

import type { TFunction } from 'i18next';

import { Input } from '@/shared/ui';

type SidebarProjectGroupHeaderProps = {
  name: string;
  projectCount: number;
  collapsed: boolean;
  /** 드래그 중인 프로젝트가 이 그룹 위에 있는가. */
  isDropTarget: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggleCollapsed: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  t: TFunction;
};

/**
 * 프로젝트 묶음의 머리글.
 *
 * 접기, 이름 변경, 순서 이동, 삭제가 전부 여기 붙는다. 드롭 대상이기도 해서,
 * 프로젝트 행을 끌어와 이 위에 놓으면 그 그룹으로 들어간다.
 */
export default function SidebarProjectGroupHeader({
  name,
  projectCount,
  collapsed,
  isDropTarget,
  canMoveUp,
  canMoveDown,
  onToggleCollapsed,
  onRename,
  onDelete,
  onMove,
  onDragOver,
  onDragLeave,
  onDrop,
  t,
}: SidebarProjectGroupHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const commitRename = () => {
    const next = draft.trim();
    if (next && next !== name) {
      onRename(next);
    }
    setIsEditing(false);
  };

  const GroupIcon = collapsed ? Folder : FolderOpen;

  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`group/groupheader mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors first:mt-0 ${
        isDropTarget ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-accent/40'
      }`}
    >
      {isEditing ? (
        <>
          <GroupIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitRename();
              }
              if (event.key === 'Escape') {
                setDraft(name);
                setIsEditing(false);
              }
            }}
            className="h-6 flex-1 px-1.5 py-0 text-xs"
          />
          <button
            type="button"
            onClick={commitRename}
            className="flex h-5 w-5 items-center justify-center rounded text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20"
            title={t('common:actions.save', { defaultValue: 'Save' })}
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(name);
              setIsEditing(false);
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
            title={t('common:actions.cancel', { defaultValue: 'Cancel' })}
          >
            <X className="h-3 w-3" />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <GroupIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {name}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/60">
              {projectCount}
            </span>
          </button>

          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/groupheader:opacity-100">
            <button
              type="button"
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
              title={t('sidebar:groups.moveUp', { defaultValue: 'Move group up' })}
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <button
              type="button"
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-30"
              title={t('sidebar:groups.moveDown', { defaultValue: 'Move group down' })}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(name);
                setIsEditing(true);
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              title={t('sidebar:groups.rename', { defaultValue: 'Rename group' })}
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
              title={t('sidebar:groups.delete', { defaultValue: 'Delete group (projects are kept)' })}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
