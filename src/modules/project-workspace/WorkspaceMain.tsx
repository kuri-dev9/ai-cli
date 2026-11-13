import React, { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, X } from 'lucide-react';

import { ChatInterface } from '@/modules/chat';
import { RoomInterface, RoomSessionNotice } from '@/modules/rooms';
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
import { CodeEditor, EditorSidebar, getPreviewKind, useEditorSidebar } from '@/modules/code-editor';
import { MediaLibraryPanel } from '@/modules/media-library';
import type { CodeEditorDiffInfo } from '@/shared/types';
import { useMediaFolders } from '@/shared/hooks/useMediaFolders';
import { useIsPlainChatView, useRoomIndexSync, useRoomMembership } from '@/shared/hooks/useRoomIndex';
import WorkspaceHeader from '@/modules/project-workspace/WorkspaceHeader';
import WorkspaceStateView from '@/modules/project-workspace/WorkspaceStateView';
import WorkspaceErrorBoundary from '@/modules/project-workspace/WorkspaceErrorBoundary';

/** 데스크톱에서 탭 대신 오른쪽 절반에 여는 화면. */
type SidePanelTab = 'files' | 'git';

const isSidePanelTab = (tab: AppTab): tab is SidePanelTab => tab === 'files' || tab === 'git';

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
  /** Silently re-syncs the sidebar project list after worktree projects change. */
  onProjectsRefresh: () => void;
};

/** Rendered by ProjectMainRegion to show the selected project's active tab: chat (or the team room view for a room host session), files, shell, git, tasks, browser or a plugin. */
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
}: WorkspaceMainProps) {
  const { t } = useTranslation();
  const preferences = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const browserUseEnabled = useBrowserUseEnabled();

  useTaskMasterProjectSync(selectedProject);

  // A session that hosts a team room opens as the room view instead of chat,
  // unless the URL asks for its plain chat. Participant sessions are not hosts,
  // so they always open as chats. Any room member's chat gets a notice that
  // leads back to the room.
  useRoomIndexSync();
  const plainChatView = useIsPlainChatView();
  const roomMembership = useRoomMembership(selectedSession?.id);
  const roomHostSessionId = roomMembership?.isHost && !plainChatView ? roomMembership.room.hostSessionId : null;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

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

  // 채팅의 "보기" 단추. 문서는 미리보기로 열고, Claude 가 고치면 따라 갱신한다.
  // 답변 속 `초안.md` 처럼 이름만 적힌 것도 프로젝트에서 찾아 연다.
  const handleDocumentOpen = useCallback((filePath: string) => {
    handleFileOpen(filePath, null, { document: true });
  }, [handleFileOpen]);
  const openDocument = useFileOpenResolver(selectedProject, handleDocumentOpen);

  // 파일과 소스 관리는 데스크톱에서 탭을 바꾸지 않고, 지금 화면(채팅·셸 등)
  // 오른쪽 절반에 띄운다. 크게 볼 일이 없어 대화를 보면서 곁에 두는 편이 낫다.
  // 모바일은 폭이 모자라 예전처럼 화면 전체로 연다.
  const [sidePanel, setSidePanel] = useState<SidePanelTab | null>(null);
  // 오른쪽 패널을 여는 동안 왼쪽에 남길 화면. 파일·소스 관리가 아닌 마지막 탭이다.
  const lastMainTabRef = useRef<AppTab>(isSidePanelTab(activeTab) ? 'chat' : activeTab);
  const useSplitPanels = !isMobile;

  const selectTab = useCallback<Dispatch<SetStateAction<AppTab>>>((next) => {
    if (!useSplitPanels) {
      setActiveTab(next);
      return;
    }
    const target = typeof next === 'function' ? next(activeTab) : next;
    if (isSidePanelTab(target)) {
      // 같은 단추를 다시 누르면 닫는다.
      setSidePanel((current) => (current === target ? null : target));
      return;
    }
    setActiveTab(target);
  }, [activeTab, setActiveTab, useSplitPanels]);

  // 명령 팔레트, 저장된 마지막 탭 등 다른 길로 파일·소스 관리 탭이 열려도
  // 데스크톱에서는 오른쪽 패널로 돌린다.
  useEffect(() => {
    if (!isSidePanelTab(activeTab)) {
      lastMainTabRef.current = activeTab;
      return;
    }
    if (useSplitPanels) {
      setSidePanel(activeTab);
      setActiveTab(lastMainTabRef.current);
    }
  }, [activeTab, setActiveTab, useSplitPanels]);

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
  usePaletteOpsRegister({ openFile, openFileInEditor, openDocument });

  // 오른쪽 패널이 열려 있으면 파일은 그 패널 안에서 연다. 바깥에 에디터를 하나 더
  // 붙이면 채팅·패널·에디터 세 칸이 되어 채팅이 최소 폭까지 밀린다. 크게 보기를
  // 누르면 예전처럼 바깥 에디터가 화면을 채운다.
  const editorInSidePanel = Boolean(useSplitPanels && sidePanel && editingFile && !editorExpanded);

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
        setActiveTab={selectTab}
        sidePanel={useSplitPanels ? sidePanel : null}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onToggleMediaLibrary={hasMediaFolders ? handleToggleMediaLibrary : null}
        mediaLibraryOpen={mediaLibraryOpen}
        onSessionEstablished={onSessionEstablished}
        onNavigateToSession={onNavigateToSession}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <WorkspaceErrorBoundary showDetails>
              {roomHostSessionId ? (
                <RoomInterface
                  key={roomHostSessionId}
                  hostSessionId={roomHostSessionId}
                  hostSession={selectedSession}
                  selectedProject={selectedProject}
                  onNavigateToSession={onNavigateToSession}
                  onFileOpen={handleWorkspaceFileOpen}
                  onShowSettings={onShowSettings}
                  showRawParameters={showRawParameters}
                  showThinking={showThinking}
                  sendByCtrlEnter={sendByCtrlEnter}
                />
              ) : (
                <div className="flex h-full flex-col">
                  {roomMembership && (
                    <RoomSessionNotice
                      membership={roomMembership}
                      onBackToRoom={(hostSessionId) => onNavigateToSession(hostSessionId)}
                    />
                  )}
                  <div className="min-h-0 flex-1">
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
                  </div>
                </div>
              )}
            </WorkspaceErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree selectedProject={selectedProject} onFileOpen={handleWorkspaceFileOpen} />
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="h-full w-full overflow-hidden">
              {/* 에이전트 CLI 가 아니라 내 로그인 쉘을 띄우는 웹 터미널이다. 대화는 채팅 탭이
                  맡으므로 세션과 묶지 않는다 — 프로젝트마다 터미널 하나가 유지된다. */}
              <StandaloneShell
                project={selectedProject}
                session={null}
                isPlainShell
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

        {useSplitPanels && sidePanel && (
          <div className={`flex min-h-0 w-1/2 min-w-[320px] shrink-0 flex-col border-l border-border ${editorExpanded ? 'hidden' : ''}`}>
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border/60 px-3 py-1.5">
              {editorInSidePanel ? (
                <button
                  type="button"
                  onClick={handleCloseEditor}
                  className="inline-flex items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {t(sidePanel === 'files' ? 'tabs.files' : 'tabs.git')}
                </button>
              ) : (
                <span className="text-xs font-medium text-muted-foreground">
                  {t(sidePanel === 'files' ? 'tabs.files' : 'tabs.git')}
                </span>
              )}
              <button
                type="button"
                onClick={() => setSidePanel(null)}
                aria-label={t('buttons.close')}
                title={t('buttons.close')}
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {editorInSidePanel && editingFile && (
              <div className="min-h-0 flex-1 overflow-hidden">
                <CodeEditor
                  file={editingFile}
                  onClose={handleCloseEditor}
                  projectPath={selectedProject.path}
                  isSidebar
                  onToggleExpand={handleToggleEditorExpand}
                />
              </div>
            )}
            {/* 파일을 보는 동안에도 목록은 내리지 않는다. 펼친 폴더와 스크롤이 그대로 남는다. */}
            <div className={`min-h-0 flex-1 overflow-hidden ${editorInSidePanel ? 'hidden' : ''}`}>
              {sidePanel === 'files' ? (
                <FileTree selectedProject={selectedProject} onFileOpen={handleWorkspaceFileOpen} />
              ) : (
                <GitPanel
                  selectedProject={selectedProject}
                  isMobile={isMobile}
                  onFileOpen={handleWorkspaceFileOpen}
                  onProjectSelect={onProjectSelect}
                  onProjectsRefresh={onProjectsRefresh}
                />
              )}
            </div>
          </div>
        )}

        {/* 한 번 열면 계속 마운트된 채로 둔다. 에디터를 열면 가려질 뿐이라
            듣던 곡이 끊기지 않고, 돌아오면 그 지점부터 이어진다. */}
        {/* 폴더를 연결하지 않았어도, 바깥에서 파일을 열어 달라고 하면 띄운다.
            음표 버튼만 폴더가 있을 때 나온다. */}
        {mediaLibraryOpen && (
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
          editingFile={editorInSidePanel ? null : editingFile}
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
