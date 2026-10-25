import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useRoomMembership } from '@/shared/hooks/useRoomIndex';
import type { RoomIndexEntry } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

type RoomMembersMarkProps = {
  participants: RoomIndexEntry['participants'];
  className?: string;
};

/**
 * A room icon followed by its members' stacked provider logos. Used by the
 * sidebar module in place of a room row's provider logo.
 */
export function RoomMembersMark({ participants, className }: RoomMembersMarkProps) {
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 rounded-md bg-primary/10 px-1 text-primary', className)}
      title={participants.map((member) => member.displayName).join(', ')}
    >
      <Users className="h-3 w-3" aria-hidden />
      <span className="flex -space-x-1">
        {participants.map((member) => (
          <span key={member.participantId} className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <LLMProviderLogo provider={member.provider} className="h-2.5 w-2.5" />
          </span>
        ))}
      </span>
    </span>
  );
}

type RoomSessionBadgeProps = {
  sessionId: string;
};

/**
 * Used by the sidebar module's session rows to mark room sessions: a room
 * host shows the members' stacked provider logos, a non-host participant
 * shows "룸 참가자 · {name}". Renders nothing for ordinary sessions.
 */
export function RoomSessionBadge({ sessionId }: RoomSessionBadgeProps) {
  const { t } = useTranslation('chat');
  const membership = useRoomMembership(sessionId);

  if (!membership) {
    return null;
  }

  if (!membership.isHost) {
    return (
      <span className="truncate text-[11px] text-muted-foreground">
        {t('rooms.badgeParticipant', { name: membership.participant?.displayName ?? '' })}
      </span>
    );
  }

  const members = membership.room.participants;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
      title={members.map((member) => member.displayName).join(', ')}
    >
      <Users className="h-2.5 w-2.5" aria-hidden />
      {t('rooms.badgeRoom')}
      <span className="ml-0.5 flex -space-x-1">
        {members.map((member) => (
          <span key={member.participantId} className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
            <LLMProviderLogo provider={member.provider} className="h-2.5 w-2.5" />
          </span>
        ))}
      </span>
    </span>
  );
}
