import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useRoomMembership } from '@/shared/hooks/useRoomIndex';
import type { RoomIndexEntry } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** 룸 표시에 얹는 로고 수. 참가자가 늘수록 로고가 줄줄이 늘어 줄이 길어지던 것을 막는다. */
const MAX_MARK_LOGOS = 2;

/**
 * 룸 표시에 얹을 프로바이더 로고. 같은 프로바이더는 묶어, 많아야 두 개만 둔다.
 * Claude 뿐이면 클클, Codex 뿐이면 코코, 섞였으면 클코 — 참가자 순서대로
 * 처음 나온 두 종류다. 한 종류뿐이어도 두 개를 겹쳐 "여럿" 임을 보인다.
 */
export function pickRoomMarkProviders(participants: Array<{ provider: string }>): string[] {
  const distinct = [...new Set(participants.map((member) => member.provider))].slice(0, MAX_MARK_LOGOS);
  if (distinct.length === 1 && participants.length > 1) {
    return [distinct[0], distinct[0]];
  }
  return distinct;
}

function StackedProviderLogos({ participants }: { participants: Array<{ provider: string }> }) {
  return (
    <span className="flex -space-x-1">
      {pickRoomMarkProviders(participants).map((provider, index) => (
        <span key={`${provider}-${index}`} className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
          <LLMProviderLogo provider={provider} className="h-2.5 w-2.5" />
        </span>
      ))}
    </span>
  );
}

type RoomMembersMarkProps = {
  participants: RoomIndexEntry['participants'];
  className?: string;
};

/**
 * A room icon followed by up to two stacked provider logos for its members. Used by the
 * sidebar module in place of a room row's provider logo.
 */
export function RoomMembersMark({ participants, className }: RoomMembersMarkProps) {
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 rounded-md bg-primary/10 px-1 text-primary', className)}
      title={participants.map((member) => member.displayName).join(', ')}
    >
      <Users className="h-3 w-3" aria-hidden />
      <StackedProviderLogos participants={participants} />
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
      <span className="ml-0.5">
        <StackedProviderLogos participants={members} />
      </span>
    </span>
  );
}
