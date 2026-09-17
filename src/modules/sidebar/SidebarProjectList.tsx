import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { FolderPlus } from 'lucide-react';

import type { Project, SidebarProjectListProps } from '@/shared/types';
import { Input } from '@/shared/ui';
import { getPageTitle } from '@/shared/utils';
import SidebarProjectGroupHeader from '@/modules/sidebar/SidebarProjectGroupHeader';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';
import { partitionProjectsByGroup, useProjectGroups } from '@/modules/sidebar/projectGroups';

/** 드래그 중인 프로젝트를 식별하는 데이터 타입. */
const PROJECT_DRAG_TYPE = 'application/x-project-id';

/** 미분류 영역을 드롭 대상으로 다룰 때 쓰는 키. */
const UNGROUPED = '__ungrouped__';

/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  activeRename,
  initialSessionsLoaded,
  currentTime,

  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  getProjectLastActivity,
  hasHiddenProviders,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  attentionSessionIds,
  forceExpanded = false,
  isProjectStarred,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onCancelEditingProject,
  onSaveProjectName,
  onOpenProjectSettings,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const pageTitle = getPageTitle(selectedProject, selectedSession);
  const {
    groups,
    createGroup,
    renameGroup,
    deleteGroup,
    toggleGroupCollapsed,
    assignProject,
    moveGroup,
    assignments,
  } = useProjectGroups();
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const newGroupInputRef = useRef<HTMLInputElement>(null);

  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  useEffect(() => {
    if (isCreatingGroup) {
      newGroupInputRef.current?.focus();
    }
  }, [isCreatingGroup]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;
  const { ungrouped, byGroup } = partitionProjectsByGroup(filteredProjects, {
    groups,
    assignments,
  });

  // 모든 프로젝트 행이 이 함수를 받는다. 렌더마다 새로 만들면 행의 memo 경계가
  // 통째로 깨져서, 한 행의 이름을 고치는 동안 목록 전체가 다시 그려진다.
  const handleDragStart = useCallback((event: DragEvent<HTMLElement>, projectId: string) => {
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, projectId);
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = (event: DragEvent<HTMLDivElement>, targetId: string) => {
    if (!event.dataTransfer.types.includes(PROJECT_DRAG_TYPE)) {
      return;
    }
    // 기본 동작을 막아야만 드롭이 허용된다.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetId(targetId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, groupId: string | null) => {
    const projectId = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
    setDropTargetId(null);
    if (!projectId) {
      return;
    }
    event.preventDefault();
    assignProject(projectId, groupId);
  };

  const commitNewGroup = () => {
    const name = newGroupName.trim();
    if (name) {
      createGroup(name);
    }
    setNewGroupName('');
    setIsCreatingGroup(false);
  };

  const renderProject = (project: Project) => {
    // Both renames are resolved here rather than inside the row, so
    // every other row is handed the same scalars on each keystroke and
    // its memo boundary holds.
    const renamingProject =
      activeRename?.target === 'project' && activeRename.id === project.projectId
        ? activeRename
        : null;
    const renamingSession =
      activeRename?.target === 'session' && activeRename.projectId === project.projectId
        ? activeRename
        : null;

    // React key + per-project state lookups all use the DB `projectId`
    // so they remain stable across renames and session changes.
    return (
      <SidebarProjectItem
        key={project.projectId}
        project={project}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        isExpanded={forceExpanded || expandedProjects.has(project.projectId)}
        isDeleting={deletingProjects.has(project.projectId)}
        isStarred={isProjectStarred(project.projectId)}
        isEditing={renamingProject !== null}
        renameDraft={renamingProject?.draft ?? ''}
        sessions={getProjectSessions(project)}
        lastActivity={getProjectLastActivity(project)}
        hasHiddenProviders={hasHiddenProviders}
        initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
        isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
        currentTime={currentTime}
        sessionRenameId={renamingSession?.id ?? null}
        sessionRenameDraft={renamingSession?.draft ?? ''}
        tasksEnabled={tasksEnabled}
        mcpServerStatus={mcpServerStatus}
        onDragStartProject={handleDragStart}
        onRenameDraftChange={onRenameDraftChange}
        onToggleProject={onToggleProject}
        onProjectSelect={onProjectSelect}
        onToggleStarProject={onToggleStarProject}
        onCancelEditingProject={onCancelEditingProject}
        onSaveProjectName={onSaveProjectName}
        onOpenProjectSettings={onOpenProjectSettings}
        onDeleteProject={onDeleteProject}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        activeSessions={activeSessions}
        attentionSessionIds={attentionSessionIds}
        onNewSession={onNewSession}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        t={t}
      />
    );
  };

  return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {!showProjects ? (
          state
        ) : (
          <>
            {groups.map((group, index) => {
              const groupProjects = byGroup.get(group.id) ?? [];

              return (
                <Fragment key={group.id}>
                  <SidebarProjectGroupHeader
                    name={group.name}
                    projectCount={groupProjects.length}
                    collapsed={group.collapsed}
                    isDropTarget={dropTargetId === group.id}
                    canMoveUp={index > 0}
                    canMoveDown={index < groups.length - 1}
                    onToggleCollapsed={() => toggleGroupCollapsed(group.id)}
                    onRename={(name) => renameGroup(group.id, name)}
                    onDelete={() => deleteGroup(group.id)}
                    onMove={(direction) => moveGroup(group.id, direction)}
                    onDragOver={(event) => handleDragOver(event, group.id)}
                    onDragLeave={() => setDropTargetId(null)}
                    onDrop={(event) => handleDrop(event, group.id)}
                    t={t}
                  />
                  {/*
                    접힌 그룹은 행을 아예 그리지 않는다. 목록을 짧게 만들자고
                    만든 기능이라, 숨기는 대신 높이만 0으로 줄이는 식은 의미가 없다.
                  */}
                  {!group.collapsed && groupProjects.map(renderProject)}
                </Fragment>
              );
            })}

            {/*
              그룹을 하나도 만들지 않았다면 이 영역이 곧 기존 화면이다 — 머리글
              없이 프로젝트만 늘어놓는다. 그룹이 생긴 뒤에야 "어디에도 안 속한
              프로젝트"라는 구분이 의미를 갖는다.
            */}
            {groups.length > 0 && (
              <div
                onDragOver={(event) => handleDragOver(event, UNGROUPED)}
                onDragLeave={() => setDropTargetId(null)}
                onDrop={(event) => handleDrop(event, null)}
                className={`mt-2 rounded-lg px-2 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                  dropTargetId === UNGROUPED
                    ? 'bg-primary/10 text-foreground ring-1 ring-primary/40'
                    : 'text-muted-foreground/60'
                }`}
              >
                {t('sidebar:groups.ungrouped', { defaultValue: 'Ungrouped' })}
                <span className="ml-1.5 font-mono tabular-nums text-muted-foreground/60">
                  {ungrouped.length}
                </span>
              </div>
            )}
            {ungrouped.map(renderProject)}

            {isCreatingGroup ? (
              <div className="mt-2 flex items-center gap-1.5 px-2">
                <Input
                  ref={newGroupInputRef}
                  value={newGroupName}
                  placeholder={t('sidebar:groups.namePlaceholder', { defaultValue: 'Group name' })}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  onBlur={commitNewGroup}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitNewGroup();
                    }
                    if (event.key === 'Escape') {
                      setNewGroupName('');
                      setIsCreatingGroup(false);
                    }
                  }}
                  className="h-7 px-2 py-0 text-xs"
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsCreatingGroup(true)}
                className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                {t('sidebar:groups.create', { defaultValue: 'New group' })}
              </button>
            )}
          </>
        )}
    </div>
  );
}
