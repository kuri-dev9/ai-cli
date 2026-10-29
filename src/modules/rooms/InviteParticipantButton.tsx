import { useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { ROOM_INVITABLE_PROVIDERS } from '@/shared/constants';
import { applyRoomDetailToIndex, useRoomMembership } from '@/shared/hooks/useRoomIndex';
import type { LLMProvider, Project, RoomDetail, SessionEstablishedContext } from '@/shared/types';
import { Button } from '@/shared/ui';
import { readUserPreference } from '@/shared/userSettings';
import InviteParticipantModal from '@/modules/rooms/InviteParticipantModal';

type InviteParticipantButtonProps = {
  /**
   * The open chat session that becomes the room host on the first invite.
   * `null` 이면 아직 한 마디도 하지 않은 새 대화다 — 초대할 때 호스트 세션을
   * 만든다.
   */
  sessionId: string | null;
  project: Project;
  onSessionEstablished: (sessionId: string, context: SessionEstablishedContext) => void;
  onNavigateToSession: (sessionId: string) => void;
};

/** 새 대화의 호스트가 쓸 프로바이더. 룸에 들일 수 없는 것을 골라 뒀으면 Claude 로 연다. */
function readHostProvider(): LLMProvider {
  const selected = readUserPreference<string>('selectedProvider', 'claude');
  return (ROOM_INVITABLE_PROVIDERS as readonly string[]).includes(selected)
    ? selected as LLMProvider
    : 'claude';
}

/**
 * Used by the project-workspace module's header to offer "[+ 참가자]" on a
 * plain chat session — or on a new chat that has no session yet. The first
 * successful invite converts the session into a room; the room index is
 * updated immediately so the workspace swaps the chat for the room view.
 * Renders nothing for sessions that are already in a room, whose member list
 * lives in the room view itself.
 */
export function InviteParticipantButton({
  sessionId,
  project,
  onSessionEstablished,
  onNavigateToSession,
}: InviteParticipantButtonProps) {
  const { t } = useTranslation('chat');
  const membership = useRoomMembership(sessionId ?? undefined);
  // Whether the invite modal is open.
  const [open, setOpen] = useState(false);
  // 새 대화에서 만든 호스트 세션. 초대가 실패해 다시 눌러도 빈 세션을 또
  // 만들지 않도록 한 번 만든 것을 쓴다.
  const createdHostRef = useRef<{ sessionId: string; provider: LLMProvider } | null>(null);

  if (membership) {
    return null;
  }

  const resolveHostSessionId = async (): Promise<string> => {
    if (sessionId) {
      return sessionId;
    }
    if (createdHostRef.current) {
      return createdHostRef.current.sessionId;
    }

    const provider = readHostProvider();
    const response = await api.providers.createSession({
      provider,
      projectPath: project.fullPath || project.path || '',
      initialMessage: t('rooms.newRoomTitle'),
    });
    const body = await readApiJson<{ data?: { sessionId?: string } }>(response);
    const createdSessionId = body.data?.sessionId;
    if (!createdSessionId) {
      throw new Error('Failed to start a new session: no session id returned.');
    }
    createdHostRef.current = { sessionId: createdSessionId, provider };
    return createdSessionId;
  };

  const handleInvited = (detail: RoomDetail) => {
    applyRoomDetailToIndex(detail);
    const created = createdHostRef.current;
    if (!sessionId && created) {
      // 사이드바와 워크스페이스가 이 세션을 알게 한 뒤 그리로 간다. 룸 목록에는
      // 이미 올렸으므로 열리는 화면은 채팅이 아니라 룸이다.
      onSessionEstablished(created.sessionId, {
        provider: created.provider,
        project,
        summary: t('rooms.newRoomTitle'),
      });
      onNavigateToSession(created.sessionId);
      createdHostRef.current = null;
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 flex-shrink-0 gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-accent/80 hover:text-foreground"
        onClick={() => setOpen(true)}
        title={t('rooms.inviteButtonTitle')}
        aria-label={t('rooms.inviteButtonTitle')}
      >
        <UserPlus className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('rooms.inviteButton')}</span>
      </Button>
      <InviteParticipantModal
        open={open}
        onOpenChange={setOpen}
        target={{ kind: 'create', resolveHostSessionId }}
        takenNames={[]}
        onInvited={handleInvited}
      />
    </>
  );
}
