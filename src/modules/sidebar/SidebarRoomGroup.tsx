import { useState } from 'react';
import type { ComponentProps } from 'react';
import { useNavigate } from 'react-router-dom';

import { sessionPath, useIsPlainChatView } from '@/shared/hooks/useRoomIndex';
import type { LLMProvider, SessionWithProvider } from '@/shared/types';
import { RoomMembersMark } from '@/modules/rooms';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import type { SidebarRoomGroup as RoomGroup } from '@/modules/sidebar/utils/roomGroups';

type SessionItemProps = ComponentProps<typeof SidebarSessionItem>;

type SidebarRoomGroupProps = Omit<SessionItemProps, 'isProcessing' | 'needsAttention' | 'isEditing' | 'renameDraft'> & {
  group: RoomGroup;
  activeSessions: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  sessionRenameId: string | null;
  sessionRenameDraft: string;
};

/**
 * Rendered by SidebarProjectSessions for a session that hosts a team room: the
 * host row opens the room, and the participants' own sessions fold under it the
 * way sessions fold under a project. Every member is listed there, the host
 * included: the room row stands for the room, and the host's own row opens its
 * session as a plain chat. The row's leading room mark toggles the fold, and the
 * room row carries the members' running and attention state while they are
 * folded away.
 */
export default function SidebarRoomGroup({
  group,
  activeSessions,
  attentionSessionIds,
  sessionRenameId,
  sessionRenameDraft,
  session,
  selectedSession,
  t,
  ...rowProps
}: SidebarRoomGroupProps) {
  const navigate = useNavigate();
  const plainChatView = useIsPlainChatView();
  const memberIds = group.members.map((member) => member.participant.sessionId);
  // Open while the room or one of its members is the open session, folded otherwise.
  const isRoomOpen = selectedSession?.id === session.id || memberIds.some((id) => id === selectedSession?.id);
  // A fold set by hand through the room mark. It holds until the room is opened
  // or left, which hands the fold back to the automatic rule.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  // Adjusted during render rather than in an effect, so the row never paints the stale fold first.
  const [seenRoomOpen, setSeenRoomOpen] = useState(isRoomOpen);
  if (isRoomOpen !== seenRoomOpen) {
    setSeenRoomOpen(isRoomOpen);
    setManualExpanded(null);
  }
  const expanded = manualExpanded ?? isRoomOpen;

  const rowState = (id: string) => ({
    isProcessing: activeSessions.has(id),
    needsAttention: attentionSessionIds.has(id),
    isEditing: id === sessionRenameId,
    renameDraft: id === sessionRenameId ? sessionRenameDraft : '',
  });
  const hostState = rowState(session.id);
  // The room row and the host's own row are the same session; the URL's view
  // decides which of the two is the open one.
  const isHostOpen = selectedSession?.id === session.id;
  const hostParticipant = group.room.participants.find((participant) => participant.sessionId === session.id);
  const hostChatSession: SessionWithProvider = {
    ...session,
    summary: hostParticipant
      ? `${hostParticipant.displayName} · ${hostParticipant.roleName} (${t('rooms.host', { defaultValue: 'host' })})`
      : session.summary,
  };
  const openHostChat: SessionItemProps['onSessionSelect'] = (target, projectId) => {
    rowProps.onSessionSelect(target, projectId);
    navigate(sessionPath(target.id, 'chat'), { replace: true });
  };
  const folded = !expanded;
  const toggleLabel = expanded
    ? t('rooms.collapseRoom', { defaultValue: 'Hide room participants' })
    : t('rooms.expandRoom', { count: memberIds.length, defaultValue: 'Show {{count}} room participants' });

  return (
    <div>
      <SidebarSessionItem
        {...rowProps}
        {...hostState}
        session={session}
        selectedSession={isHostOpen && plainChatView ? null : selectedSession}
        isProcessing={hostState.isProcessing || (folded && memberIds.some((id) => activeSessions.has(id)))}
        needsAttention={hostState.needsAttention || (folded && memberIds.some((id) => attentionSessionIds.has(id)))}
        leading={{
          content: <RoomMembersMark participants={group.room.participants} />,
          label: toggleLabel,
          expanded,
          onClick: () => setManualExpanded(!expanded),
        }}
        t={t}
      />

      {expanded && (
        <div className="ml-2 mt-1 space-y-1 border-l border-border pl-2">
          <SidebarSessionItem
            {...rowProps}
            {...hostState}
            // Renaming the host renames the room; that edit opens on the room row.
            isEditing={false}
            renameDraft=""
            session={hostChatSession}
            selectedSession={isHostOpen && plainChatView ? selectedSession : null}
            onSessionSelect={openHostChat}
            hideRoomBadge
            t={t}
          />
          {group.members.map(({ participant, session: loaded }) => {
            // A participant on a page of the list not loaded yet still gets a
            // row; the room index knows enough to draw and open it.
            const memberSession: SessionWithProvider = loaded ?? {
              id: participant.sessionId,
              summary: `[룸] ${participant.displayName} · ${participant.roleName}`,
              __provider: participant.provider as LLMProvider,
              __projectId: rowProps.project.projectId,
            };
            return (
              <SidebarSessionItem
                key={participant.sessionId}
                {...rowProps}
                {...rowState(participant.sessionId)}
                session={memberSession}
                selectedSession={selectedSession}
                hideRoomBadge
                t={t}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
