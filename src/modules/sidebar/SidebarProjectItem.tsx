import { memo, useEffect, useMemo, useRef } from 'react';
import type { DragEvent } from 'react';
import { Check, ChevronDown, ChevronRight, Settings2, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { resolveProjectActivity } from '@/modules/sidebar/utils/projectActivity';
import { cn } from '@/shared/utils';
import type { LLMProvider, MCPServerStatus, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { formatAbsoluteDateTime, formatCompactAge, getTaskIndicatorStatus } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import TaskIndicator from '@/modules/sidebar/TaskIndicator';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  /**
   * 이 프로젝트에서 마지막으로 대화한 시각(ISO). 꺼 둔 CLI 의 대화는 빠져 있다.
   * 비어 있으면 시각을 그리지 않는다.
   */
  lastActivity: string;
  /** 꺼 둔 CLI 가 있어 `sessions` 가 걸러진 목록인지. 개수 배지가 이 값을 본다. */
  hasHiddenProviders: boolean;
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onOpenProjectSettings: (project: Project) => void;
  /** 그룹 사이로 끌어 옮길 때 목록 쪽에서 드래그 데이터를 채운다. */
  onDragStartProject?: (event: DragEvent<HTMLElement>, projectId: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

/**
 * 행 개수 배지.
 *
 * 평소에는 서버가 세어 준 전체 개수를 쓴다 — 아직 다 받아 오지 않았어도 이 프로젝트에
 * 대화가 몇 개 있는지는 그 수가 맞다. 다만 꺼 둔 CLI 가 있어 목록을 거르고 있을 때는
 * 그 수에 감춘 대화까지 들어 있어, 배지가 "12" 인데 펼치면 아무것도 없는 화면이 된다.
 * 그때는 실제로 보이는 개수를 쓴다.
 */
const getSessionCountDisplay = (
  project: Project,
  sessions: SessionWithProvider[],
  hasHiddenProviders: boolean,
): number => (
  hasHiddenProviders ? sessions.length : Number(project.sessionMeta?.total ?? sessions.length)
);

/** Rendered by SidebarProjectList for one project row, including its expand, rename, star and delete controls. */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  lastActivity,
  hasHiddenProviders,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  tasksEnabled,
  mcpServerStatus,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onCancelEditingProject,
  onSaveProjectName,
  onOpenProjectSettings,
  onDragStartProject,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const totalSessionCount = getSessionCountDisplay(project, sessions, hasHiddenProviders);
  const sessionCountDisplay = String(totalSessionCount);
  // 세션 행과 같은 포맷 함수를 쓴다 — 같은 사이드바 안에서 `2hr` 과 `2시간 전` 이
  // 섞이면 안 된다.
  const lastActivityAge = formatCompactAge(lastActivity, currentTime);
  const lastActivityAt = formatAbsoluteDateTime(lastActivity);
  const lastActivityTooltip = t('tooltips.lastActivity');
  const sessionCountLabel = `${sessionCountDisplay} session${totalSessionCount === 1 ? '' : 's'}`;
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);

  // 색은 세션 줄과 같은 약속을 쓴다 — 손이 필요한 쪽이 amber, 그냥 돌고 있는
  // 쪽이 green 이다.
  const projectActivity = useMemo(
    () => resolveProjectActivity(sessions, attentionSessionIds, activeSessions),
    [sessions, attentionSessionIds, activeSessions],
  );

  const projectActivityLabel = projectActivity === 'attention'
    ? t('tooltips.projectNeedsAttention', { defaultValue: '이 프로젝트에 확인할 대화가 있습니다' })
    : t('tooltips.projectProcessing', { defaultValue: '이 프로젝트에서 작업이 돌고 있습니다' });
  const mobileRenameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !mobileRenameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        mobileRenameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  const isCompact = useCompactSidebar();

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  return (
    <div
      // 행 전체가 드래그 손잡이다. 그룹 머리글 위에 놓으면 그 그룹으로 옮겨진다.
      draggable={Boolean(onDragStartProject) && !isEditing}
      onDragStart={(event) => onDragStartProject?.(event, project.projectId)}
      className={cn('md:space-y-1', isDeleting && 'opacity-50 pointer-events-none')}
    >
      <div className="md:group group">
        {isCompact && (
        <div>
          <div
            className={cn(
              'p-3 mx-3 my-1 rounded-lg bg-card border border-border/50 active:scale-[0.98] transition-all duration-150',
              isSelected && 'bg-primary/5 border-primary/20',
              isStarred &&
                !isSelected &&
                'bg-yellow-50/50 dark:bg-yellow-900/5 border-yellow-200/30 dark:border-yellow-800/30',
            )}
            onClick={toggleProject}
            title={project.fullPath}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <button
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center active:scale-90 transition-all duration-150 border',
                    isStarred
                      ? 'bg-yellow-500/10 dark:bg-yellow-900/30 border-yellow-200 dark:border-yellow-800'
                      : 'bg-gray-500/10 dark:bg-gray-900/30 border-gray-200 dark:border-gray-800',
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleStarProject();
                  }}
                  title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                >
                  <Star
                    className={cn(
                      'w-4 h-4 transition-colors',
                      isStarred
                        ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                        : 'text-gray-600 dark:text-gray-400',
                    )}
                  />
                </button>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      ref={mobileRenameInputRef}
                      type="text"
                      value={renameDraft}
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      className="w-full rounded-lg border-2 border-primary/40 bg-background px-3 py-2 text-sm text-foreground shadow-sm transition-all duration-200 focus:border-primary focus:shadow-md focus:outline-none"
                      placeholder={t('projects.projectNamePlaceholder')}
                      autoFocus
                      autoComplete="off"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          saveProjectName();
                        }

                        if (event.key === 'Escape') {
                          onCancelEditingProject();
                        }
                      }}
                      style={{
                        fontSize: '16px',
                        WebkitAppearance: 'none',
                        borderRadius: '8px',
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center justify-between">
                        <div className="flex min-w-0 items-center gap-1.5">
                          {projectActivity && (
                            <span
                              role="status"
                              aria-label={projectActivityLabel}
                              title={projectActivityLabel}
                              className={cn(
                                'h-2 w-2 shrink-0 animate-pulse rounded-full',
                                projectActivity === 'attention' ? 'bg-amber-500' : 'bg-green-500',
                              )}
                            />
                          )}
                          <h3 className="truncate text-sm font-normal text-foreground">{project.displayName}</h3>
                        </div>
                        {tasksEnabled && (
                          <TaskIndicator
                            status={taskStatus}
                            size="xs"
                            className="ml-2 hidden flex-shrink-0 md:inline-flex"
                          />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {sessionCountLabel}
                        {lastActivityAge && (
                          <>
                            <span aria-hidden> · </span>
                            <span className="tabular-nums" title={lastActivityTooltip}>
                              {lastActivityAge}
                            </span>
                          </>
                        )}
                        {lastActivityAt && (
                          <>
                            <span aria-hidden> · </span>
                            <span className="tabular-nums" title={lastActivityTooltip}>
                              {lastActivityAt}
                            </span>
                          </>
                        )}
                      </p>
                    </>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1">
                {isEditing ? (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-green-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveProjectName();
                      }}
                    >
                      <Check className="h-4 w-4 text-white" />
                    </button>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-500 shadow-sm transition-all duration-150 active:scale-90 active:shadow-none dark:bg-gray-600"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCancelEditingProject();
                      }}
                    >
                      <X className="h-4 w-4 text-white" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-red-500/10 active:scale-90 dark:border-red-800 dark:bg-red-900/30"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteProject(project);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                    </button>

                    <button
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenProjectSettings(project);
                      }}
                    >
                      <Settings2 className="h-4 w-4 text-primary" />
                    </button>

                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/30">
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3 w-3 text-muted-foreground" />
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        )}

        {!isCompact && (
        <Button
          variant="ghost"
          className={cn(
            'flex w-full justify-between p-2 h-auto font-normal hover:bg-accent/50',
            isSelected && 'bg-accent text-accent-foreground',
            isStarred &&
              !isSelected &&
              'bg-yellow-50/50 dark:bg-yellow-900/10 hover:bg-yellow-100/50 dark:hover:bg-yellow-900/20',
          )}
          onClick={selectAndToggleProject}
          title={project.fullPath}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className={cn(
                'w-6 h-6 flex items-center justify-center rounded cursor-pointer transition-all duration-200',
                isStarred
                  ? 'hover:bg-yellow-50 dark:hover:bg-yellow-900/20'
                  : 'opacity-40 hover:opacity-100 hover:bg-accent',
              )}
              onClick={(event) => {
                event.stopPropagation();
                toggleStarProject();
              }}
              title={isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
            >
              <Star
                className={cn(
                  'w-3 h-3 transition-colors',
                  isStarred
                    ? 'text-yellow-600 dark:text-yellow-400 fill-current'
                    : 'text-muted-foreground',
                )}
              />
            </div>
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(event) => onRenameDraftChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </div>
                </div>
              ) : (
                <div>
                  {/* 이름 위에서도 경로를 볼 수 있게 두 줄로 묶는다 — 행 툴팁이 여기서는 가려진다. */}
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {projectActivity && (
                        <span
                          role="status"
                          aria-label={projectActivityLabel}
                          title={projectActivityLabel}
                          className={cn(
                            'h-2 w-2 shrink-0 animate-pulse rounded-full',
                            projectActivity === 'attention' ? 'bg-amber-500' : 'bg-green-500',
                          )}
                        />
                      )}
                      <div
                        className="truncate text-sm font-normal text-foreground"
                        title={
                          project.fullPath && project.fullPath !== project.displayName
                            ? `${project.displayName}\n${project.fullPath}`
                            : project.displayName
                        }
                      >
                        {project.displayName}
                      </div>
                    </div>
                    {/*
                      대화 개수는 이름 바로 옆이 제자리다. 둘째 줄 맨 앞에 두었을
                      때는 옆의 경과 시간과 붙어 읽혀서 무슨 숫자인지 알아보기
                      어려웠다.
                    */}
                    <span
                      className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                      title={sessionCountLabel}
                    >
                      {sessionCountDisplay}
                    </span>
                  </div>
                  {/*
                    예전에는 여기에 `...proj/vscode/QueryForge` 처럼 중간이 잘린 경로가
                    늘 붙어 있었다. 잘린 경로는 프로젝트를 구분하는 데 거의 쓸모가 없어
                    지웠고, 대신 이 프로젝트에서 마지막으로 대화한 시각을 보여준다.
                    전체 경로는 행 전체의 툴팁으로 남아 있다.
                  */}
                  <div className="text-xs text-muted-foreground">
                    {lastActivityAge && (
                      <span className="tabular-nums" title={lastActivityTooltip}>
                        {lastActivityAge}
                      </span>
                    )}
                    {lastActivityAge && lastActivityAt && <span aria-hidden>{' · '}</span>}
                    {lastActivityAt && (
                      <span className="tabular-nums" title={lastActivityTooltip}>
                        {lastActivityAt}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <>
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenProjectSettings(project);
                  }}
                  title={t('tooltips.projectSettings', {
                    defaultValue: 'Project settings (name and path)',
                  })}
                >
                  <Settings2 className="h-3 w-3" />
                </div>
                <div
                  className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProject(project);
                  }}
                  title={t('tooltips.deleteProject')}
                >
                  <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                </div>
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
                )}
              </>
            )}
          </div>
        </Button>
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
