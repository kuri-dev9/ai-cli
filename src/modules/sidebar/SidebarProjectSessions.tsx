import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onMoveSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  t: TFunction;
};

/** 접혀 있을 때 위에서부터 늘 보여 주는 최근 세션 개수. */
const RECENT_SESSION_LIMIT = 5;

/**
 * 접힌 상태에서 그릴 세션만 고른다.
 *
 * 최근 N개에 더해, 열려 있거나 돌고 있거나 확인을 기다리는 세션은 오래됐어도
 * 개수 제한 없이 남긴다. 그렇지 않으면 프로젝트에 알림 점이 떠 있는데 목록을
 * 펼쳐도 해당 세션이 안 보이는 상황이 생긴다. 순서는 원래 목록(최근순)을 따른다.
 */
const selectCollapsedSessions = (
  sessions: SessionWithProvider[],
  selectedSessionId: string | undefined,
  activeSessions: ReadonlySet<string>,
  attentionSessionIds: ReadonlySet<string>,
): SessionWithProvider[] => sessions.filter((session, index) => (
  index < RECENT_SESSION_LIMIT
  || session.id === selectedSessionId
  || activeSessions.has(session.id)
  || attentionSessionIds.has(session.id)
));

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onMoveSession,
  onLoadMoreSessions,
  t,
}: SidebarProjectSessionsProps) {
  // 오래된 세션까지 펼쳐 보고 있는지. 프로젝트를 접었다 펼쳐도 유지되도록
  // 프로젝트 행마다 따로 들고 있다.
  const [showOlderSessions, setShowOlderSessions] = useState(false);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const visibleSessions = showOlderSessions
    ? sessions
    : selectCollapsedSessions(sessions, selectedSession?.id, activeSessions, attentionSessionIds);
  const hiddenSessionCount = sessions.length - visibleSessions.length;
  const canCollapse = showOlderSessions && sessions.length > RECENT_SESSION_LIMIT;

  // 서버에서 더 받아 온 세션이 접힌 쪽으로 사라지면 눌러도 아무 일 없어 보이므로 함께 펼친다.
  const loadMoreSessions = () => {
    setShowOlderSessions(true);
    onLoadMoreSessions(project.projectId);
  };

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {visibleSessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              isProcessing={activeSessions.has(session.id)}
              needsAttention={attentionSessionIds.has(session.id)}
              currentTime={currentTime}
              onRenameDraftChange={onRenameDraftChange}
              isEditing={session.id === sessionRenameId}
              renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onForkSession={onForkSession}
              onMoveSession={onMoveSession}
              t={t}
            />
          ))}

          {/*
            더보기는 한 줄만 둔다. 접어 둔 세션이 있으면 먼저 그것을 펼치고, 받아 둔
            세션을 다 보여 준 뒤에야 서버에서 더 받아 온다.
          */}
          {hiddenSessionCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowOlderSessions(true)}
            >
              <ChevronDown className="h-3 w-3" />
              {t('sessions.showOlder', {
                count: hiddenSessionCount,
                defaultValue: 'Show {{count}} older sessions',
              })}
            </Button>
          ) : hasMoreSessions ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={loadMoreSessions}
              disabled={isLoadingMoreSessions}
            >
              <ChevronDown className="h-3 w-3" />
              {isLoadingMoreSessions
                ? t('sessions.loadingSessions')
                : t('sessions.showMore')}
            </Button>
          ) : null}

          {canCollapse && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowOlderSessions(false)}
            >
              <ChevronUp className="h-3 w-3" />
              {t('sessions.showRecentOnly', { defaultValue: 'Show recent only' })}
            </Button>
          )}
        </>
      )}

      {/*
        새 세션 버튼은 여기 두지 않는다. 세션이 쌓이면 목록 맨 아래까지 내려야
        누를 수 있었기 때문에, 프로젝트 행의 `+` 아이콘으로 옮겼다.
      */}
    </div>
  );
}
