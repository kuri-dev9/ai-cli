import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { applyRoomDetailToIndex, useRoomMembership } from '@/shared/hooks/useRoomIndex';
import { Button } from '@/shared/ui';
import InviteParticipantModal from '@/modules/rooms/InviteParticipantModal';

type InviteParticipantButtonProps = {
  /** The open chat session that becomes the room host on the first invite. */
  sessionId: string;
};

/**
 * Used by the project-workspace module's header to offer "[+ 참가자]" on a
 * plain chat session. The first successful invite converts the session into a
 * room; the room index is updated immediately so the workspace swaps the chat
 * for the room view. Renders nothing for sessions that are already in a room,
 * whose member list lives in the room view itself.
 */
export function InviteParticipantButton({ sessionId }: InviteParticipantButtonProps) {
  const { t } = useTranslation('chat');
  const membership = useRoomMembership(sessionId);
  // Whether the invite modal is open.
  const [open, setOpen] = useState(false);

  if (membership) {
    return null;
  }

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
        target={{ kind: 'create', hostSessionId: sessionId }}
        takenNames={[]}
        onInvited={applyRoomDetailToIndex}
      />
    </>
  );
}
