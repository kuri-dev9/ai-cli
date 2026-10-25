import { ArrowLeft, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { RoomMembership } from '@/shared/hooks/useRoomIndex';
import { Button } from '@/shared/ui';

type RoomSessionNoticeProps = {
  membership: RoomMembership;
  onBackToRoom: (hostSessionId: string) => void;
};

/**
 * Used by the project-workspace module above a room member's own chat: says
 * whose session this is, that what is typed here reaches only that member and
 * not the room, and links back to the room.
 */
export function RoomSessionNotice({ membership, onBackToRoom }: RoomSessionNoticeProps) {
  const { t } = useTranslation('chat');
  const participant = membership.participant;
  const name = participant ? `${participant.displayName} · ${participant.roleName}` : '';

  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-primary/5 px-3 py-1.5 text-xs text-muted-foreground">
      <Users className="h-3.5 w-3.5 flex-shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t('rooms.memberSessionNotice', { name })}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 flex-shrink-0 gap-1 px-2 text-xs"
        onClick={() => onBackToRoom(membership.room.hostSessionId)}
      >
        <ArrowLeft className="h-3 w-3" />
        {t('rooms.backToRoom')}
      </Button>
    </div>
  );
}
