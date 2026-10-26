import type { RoomParticipant } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

// Colours by participant position (host first): name dot and text, chip ring,
// and the bar down the side of that participant's reply cards.
const PARTICIPANT_COLORS = [
  { dot: 'bg-sky-500', text: 'text-sky-700 dark:text-sky-300', ring: 'border-sky-500/40 bg-sky-500/10', bar: 'border-l-sky-500/70' },
  { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', ring: 'border-amber-500/40 bg-amber-500/10', bar: 'border-l-amber-500/70' },
  { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', ring: 'border-emerald-500/40 bg-emerald-500/10', bar: 'border-l-emerald-500/70' },
  { dot: 'bg-violet-500', text: 'text-violet-700 dark:text-violet-300', ring: 'border-violet-500/40 bg-violet-500/10', bar: 'border-l-violet-500/70' },
];

/** One participant's colour set, so its chip, badge and cards always match. */
export const participantColor = (participant: RoomParticipant | undefined) =>
  PARTICIPANT_COLORS[(participant?.position ?? 0) % PARTICIPANT_COLORS.length];

/**
 * A participant's name tag: colour dot, provider logo, name, role and host or
 * departed marks. Used across the room view — chips, reply cards, mention list.
 */
export function ParticipantBadge({
  participant,
  hostLabel,
  leftLabel,
}: {
  participant: RoomParticipant | undefined;
  hostLabel: string;
  /** Set for a member who has left, to mark their earlier entries. */
  leftLabel?: string;
}) {
  const color = participantColor(participant);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', color.dot)} aria-hidden />
      <LLMProviderLogo provider={participant?.provider ?? 'claude'} className="h-3.5 w-3.5 flex-shrink-0" />
      <span className={cn('truncate text-sm font-semibold', color.text)}>{participant?.displayName ?? '?'}</span>
      {participant?.roleName && (
        <span className="truncate text-xs text-muted-foreground">{participant.roleName}</span>
      )}
      {participant?.isHost && (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{hostLabel}</span>
      )}
      {leftLabel && (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{leftLabel}</span>
      )}
    </span>
  );
}
