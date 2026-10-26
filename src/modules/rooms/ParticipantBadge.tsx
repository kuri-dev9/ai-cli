import type { RoomParticipant } from '@/shared/types';
import { LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';

/**
 * Colours by participant position (host first): name dot and text, chip ring,
 * the bar down the side of that participant's reply cards, and the wash behind
 * their `@name` in the composer. The wash is heavier than the chip's own fill —
 * it sits behind live text rather than beside it, so a tint that reads fine on
 * a chip disappears there.
 *
 * There are more of these than a room can hold members, so two participants
 * never share a colour. Neighbouring entries are kept far apart in hue as well,
 * since positions are handed out in order and adjacent chips sit side by side.
 * Every class is written out in full: Tailwind only ships the ones it can see
 * in the source, so a built-up `bg-${name}-500` would come out unstyled.
 */
const PARTICIPANT_COLORS = [
  { dot: 'bg-sky-500', text: 'text-sky-700 dark:text-sky-300', ring: 'border-sky-500/40 bg-sky-500/10', bar: 'border-l-sky-500/70', mention: 'bg-sky-500/30 dark:bg-sky-400/30' },
  { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', ring: 'border-amber-500/40 bg-amber-500/10', bar: 'border-l-amber-500/70', mention: 'bg-amber-500/30 dark:bg-amber-400/30' },
  { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', ring: 'border-emerald-500/40 bg-emerald-500/10', bar: 'border-l-emerald-500/70', mention: 'bg-emerald-500/30 dark:bg-emerald-400/30' },
  { dot: 'bg-violet-500', text: 'text-violet-700 dark:text-violet-300', ring: 'border-violet-500/40 bg-violet-500/10', bar: 'border-l-violet-500/70', mention: 'bg-violet-500/30 dark:bg-violet-400/30' },
  { dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-300', ring: 'border-rose-500/40 bg-rose-500/10', bar: 'border-l-rose-500/70', mention: 'bg-rose-500/30 dark:bg-rose-400/30' },
  { dot: 'bg-cyan-500', text: 'text-cyan-700 dark:text-cyan-300', ring: 'border-cyan-500/40 bg-cyan-500/10', bar: 'border-l-cyan-500/70', mention: 'bg-cyan-500/30 dark:bg-cyan-400/30' },
  { dot: 'bg-lime-500', text: 'text-lime-700 dark:text-lime-300', ring: 'border-lime-500/40 bg-lime-500/10', bar: 'border-l-lime-500/70', mention: 'bg-lime-500/30 dark:bg-lime-400/30' },
  { dot: 'bg-fuchsia-500', text: 'text-fuchsia-700 dark:text-fuchsia-300', ring: 'border-fuchsia-500/40 bg-fuchsia-500/10', bar: 'border-l-fuchsia-500/70', mention: 'bg-fuchsia-500/30 dark:bg-fuchsia-400/30' },
  { dot: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-300', ring: 'border-orange-500/40 bg-orange-500/10', bar: 'border-l-orange-500/70', mention: 'bg-orange-500/30 dark:bg-orange-400/30' },
  { dot: 'bg-teal-500', text: 'text-teal-700 dark:text-teal-300', ring: 'border-teal-500/40 bg-teal-500/10', bar: 'border-l-teal-500/70', mention: 'bg-teal-500/30 dark:bg-teal-400/30' },
  { dot: 'bg-indigo-500', text: 'text-indigo-700 dark:text-indigo-300', ring: 'border-indigo-500/40 bg-indigo-500/10', bar: 'border-l-indigo-500/70', mention: 'bg-indigo-500/30 dark:bg-indigo-400/30' },
  { dot: 'bg-pink-500', text: 'text-pink-700 dark:text-pink-300', ring: 'border-pink-500/40 bg-pink-500/10', bar: 'border-l-pink-500/70', mention: 'bg-pink-500/30 dark:bg-pink-400/30' },
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
  standbyLabel,
  compact = false,
}: {
  participant: RoomParticipant | undefined;
  hostLabel: string;
  /** Set for a member who has left, to mark their earlier entries. */
  leftLabel?: string;
  /** Set to mark a roster member waiting to be called by name. */
  standbyLabel?: string;
  /**
   * Drops the role and the host mark, leaving the dot, logo and name. Used by
   * the room's participant strip, where a full room would otherwise wrap the
   * status bar onto a second line.
   */
  compact?: boolean;
}) {
  const color = participantColor(participant);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', color.dot)} aria-hidden />
      <LLMProviderLogo provider={participant?.provider ?? 'claude'} className="h-3.5 w-3.5 flex-shrink-0" />
      <span className={cn('truncate font-semibold', compact ? 'text-xs' : 'text-sm', color.text)}>
        {participant?.displayName ?? '?'}
      </span>
      {!compact && participant?.roleName && (
        <span className="truncate text-xs text-muted-foreground">{participant.roleName}</span>
      )}
      {!compact && participant?.isHost && (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{hostLabel}</span>
      )}
      {/*
        "대기" 는 아직 한 번도 불린 적 없다는 뜻이다. 불려서 일한 적 있는
        멤버는 세션이 남아 있으므로 붙이지 않는다 — 방금 일을 마치고 쉬는
        참가자에게 "대기" 가 붙으면 일을 안 한 것처럼 보인다.
      */}
      {standbyLabel && participant?.status === 'standby' && !participant.sessionId && (
        <span className="rounded border border-dashed border-muted-foreground/40 px-1 text-[10px] text-muted-foreground">
          {standbyLabel}
        </span>
      )}
      {leftLabel && (
        <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{leftLabel}</span>
      )}
    </span>
  );
}
