import React, { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import { ChatInterface } from '@/modules/chat';
import { FileTree } from '@/modules/file-tree';
import { StandaloneShell } from '@/modules/standalone-shell';
import { GitPanel } from '@/modules/git-panel';
import { PluginTabContent } from '@/modules/plugins';
import { BrowserUsePanel, useBrowserUseEnabled } from '@/modules/browser-use';
import { usePaletteOpsRegister } from '@/modules/command-palette';
import { TaskMasterPanel, useTaskMasterProjectSync, useTasksSettings } from '@/modules/task-master';
import type { AppTab, Project, ProjectSession, SessionEstablishedContext, SessionNavigationOptions, SettingsMainTab } from '@/shared/types';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { useFileOpenResolver } from '@/modules/project-workspace/hooks/useFileOpenResolver';
import { EditorSidebar, getPreviewKind, useEditorSidebar } from '@/modules/code-editor';
import { MediaLibraryPanel } from '@/modules/media-library';
import type { CodeEditorDiffInfo } from '@/shared/types';
import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';

type WorkspaceMainProps = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  isMobile: boolean;
  onMenuClick: () => void;
  isLoading: boolean;
  onNavigateToSession: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings: (tab?: SettingsMainTab) => void;
  externalMessageUpdate: number;
  newSessionTrigger: number;
  /** Switches the app to another project — used by the git panel's Worktrees view. */
  onProjectSelect: (project: Project) => void;
  /** Starts a fresh chat in the open project, from the header's new-chat button. */
  onNewSession: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
};

/** Rendered by ProjectMainRegion to show the selected project's active tab: chat, files, shell, git, tasks, browser or a plugin. */
function WorkspaceMain({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  onProjectSelect,
  onProjectsRefresh,
  onNewSession,
}: WorkspaceMainProps) {
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  useTaskMasterProjectSync(selectedProject);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  // 헤더는 프로젝트를 모르는 채로 버튼만 그린다. 여기서 현재 프로젝트를 묶어 준다.
  const handleNewSessionInProject = useCallback(() => {
    if (selectedProject) {
      onNewSession(selectedProject);
    }
  }, [onNewSession, selectedProject]);

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  // 폴더를 연결한 프로젝트에서만 미디어 패널을 쓸 수 있다. 연결한 적이 없으면
  // 헤더에 음표 버튼도 두지 않는다 — 열어 봐야 빈 패널이다.
  const mediaFolders = useMediaFolders(selectedProject?.projectId);
  const hasMediaFolders = mediaFolders.length > 0;

  // 오른쪽 미디어 패널. 한 번 열리면 에디터로 전환해도 내려가지 않는다 —
  // 숨기기만 하므로 듣던 곡이 끊기지 않는다.
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);
  const [openedMediaPath, setOpenedMediaPath] = useState<string | null>(null);

  const handleToggleMediaLibrary = useCallback(() => {
    setMediaLibraryOpen((open) => !open);
  }, []);

  const handleCloseMediaLibrary = useCallback(() => {
    setMediaLibraryOpen(false);
    setOpenedMediaPath(null);
  }, []);

  // 재생할 수 있는 파일은 에디터가 아니라 미디어 패널로 보낸다. 코드처럼 열어
  // 봐야 할 것이 없고, 패널에 두어야 대화를 보면서 계속 들을 수 있다.
  const handleWorkspaceFileOpen = useCallback((filePath: string, diffInfo?: CodeEditorDiffInfo | null) => {
    const kind = getPreviewKind(filePath.split('/').pop() ?? filePath);
    if (kind === 'audio' || kind === 'video') {
      setOpenedMediaPath(filePath);
      setMediaLibraryOpen(true);
      return;
    }
    handleFileOpen(filePath, diffInfo ?? null);
  }, [handleFileOpen]);

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleWorkspaceFileOpen);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  // Stable so React.memo(ChatInterface) can bail out: an inline arrow here made
  // every WorkspaceMain render re-render the whole chat tree, including during
  // an editor-divider drag.
  const showAllTasks = useCallback(() => {
    setActiveTab('tasks');
  }, [setActiveTab]);

  const openFile = useCallback((filePath: string) => {
    setActiveTab('files');
    handleWorkspaceFileOpen(filePath);
  }, [handleWorkspaceFileOpen, setActiveTab]);

  // Opens the editor side panel in place, keeping the current tab (e.g. chat).
  const openFileInEditor = useCallback((filePath: string) => {
    resolvedFileOpen(filePath);
  }, [resolvedFileOpen]);

  // Stable arguments keep usePaletteOpsRegister's effect from tearing down and
  // rewriting the whole palette registry on every render.
  usePaletteOpsRegister({ openFile, openFileInEditor });

  if (isLoading) {
    return <WorkspaceStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <WorkspaceStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onNewSession={handleNewSessionInProject}
        onToggleMediaLibrary={hasMediaFolders ? handleToggleMediaLibrary : null}
        mediaLibraryOpen={mediaLibraryOpen}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <WorkspaceErrorBoundary showDetails>
              <ChatInterface
                isActive={activeTab === 'chat'}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleWorkspaceFileOpen}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={tasksEnabled ? showAllTasks : null}
              />
            </WorkspaceErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree selectedProject={selectedProject} onFileOpen={handleWorkspaceFileOpen} />
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="h-full w-full overflow-hidden">
              <StandaloneShell
                project={selectedProject}
                session={selectedSession}
                showHeader={false}
                isActive={activeTab === 'shell'}
              />
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel
                selectedProject={selectedProject}
                isMobile={isMobile}
                onFileOpen={handleWorkspaceFileOpen}
                onProjectSelect={onProjectSelect}
                onProjectsRefresh={onProjectsRefresh}
              />
            </div>
          )}

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          {shouldShowBrowserTab && activeTab === 'browser' && (
            <div className="h-full overflow-hidden">
              <BrowserUsePanel isVisible={activeTab === 'browser'} onShowSettings={onShowSettings} />
            </div>
          )}

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        {/* 한 번 열면 계속 마운트된 채로 둔다. 에디터를 열면 가려질 뿐이라
            듣던 곡이 끊기지 않고, 돌아오면 그 지점부터 이어진다. */}
        {mediaLibraryOpen && hasMediaFolders && (
          <div
            className={`min-h-0 shrink-0 border-l border-border ${editingFile ? 'hidden' : 'flex'
              } ${isMobile ? 'w-full' : 'w-[380px]'}`}
          >
            <MediaLibraryPanel
              projectId={selectedProject.projectId}
              openedFilePath={openedMediaPath}
              onClose={handleCloseMediaLibrary}
            />
          </div>
        )}

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          fillSpace={activeTab === 'files'}
        />
      </div>
    </div>
  );
}

export default React.memo(WorkspaceMain);
