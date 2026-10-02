import { useMemo, useState } from 'react';
import { FolderInput, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button, Input } from '@/shared/ui';
import type { PendingSessionMove, Project } from '@/shared/types';

type MoveSessionModalProps = {
  move: PendingSessionMove;
  projects: Project[];
  isMoving: boolean;
  onConfirm: (projectId: string) => void;
  onCancel: () => void;
  t: TFunction;
};

/**
 * Picks the project a session moves to. Rendered by SidebarModals while a move
 * is pending; the session's current project is left out of the choices.
 */
export default function MoveSessionModal({
  move,
  projects,
  isMoving,
  onConfirm,
  onCancel,
  t,
}: MoveSessionModalProps) {
  // Narrows a long project list as the user types; only this modal reads it.
  const [filter, setFilter] = useState('');
  // The project the user clicked, so its row can show the spinner while the
  // request runs and the others stay plainly disabled.
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);

  const choices = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return projects
      .filter((project) => project.projectId !== move.fromProjectId)
      .filter((project) => !needle
        || project.displayName.toLowerCase().includes(needle)
        || project.fullPath.toLowerCase().includes(needle))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [filter, move.fromProjectId, projects]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-session-title"
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-6 pb-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
              <FolderInput className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 id="move-session-title" className="mb-1 text-lg font-semibold text-foreground">
                {t('moveSession.title', 'Move to another project')}
              </h3>
              <p className="truncate text-sm font-medium text-foreground" title={move.sessionTitle}>
                {move.sessionTitle || t('sessions.unnamed')}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  'moveSession.description',
                  'The conversation continues in the chosen project\'s folder. The original transcript is kept on disk.',
                )}
              </p>
            </div>
          </div>
          <Input
            className="mt-4"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('moveSession.filterPlaceholder', 'Find a project')}
            disabled={isMoving}
            autoFocus
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-2">
          {choices.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('moveSession.noProjects', 'No other project to move to.')}
            </p>
          ) : (
            choices.map((project) => (
              <button
                key={project.projectId}
                type="button"
                disabled={isMoving}
                onClick={() => {
                  setChosenProjectId(project.projectId);
                  onConfirm(project.projectId);
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{project.displayName}</p>
                  <p className="truncate text-[11px] text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </p>
                </div>
                {isMoving && chosenProjectId === project.projectId && (
                  <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>

        <div className="border-t border-border bg-muted/30 p-4">
          <Button variant="ghost" className="w-full" onClick={onCancel} disabled={isMoving}>
            {isMoving ? t('moveSession.moving', 'Moving…') : t('actions.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
