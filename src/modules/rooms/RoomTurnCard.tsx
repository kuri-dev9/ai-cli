import type { ReactNode } from 'react';

import type { RoomParticipant } from '@/shared/types';
import { cn } from '@/shared/utils';
import { participantColor } from '@/modules/rooms/ParticipantBadge';

type RoomTurnCardProps = {
  participant: RoomParticipant | undefined;
  /** Name tag and status chips; stays pinned to the top while the card scrolls by. */
  header: ReactNode;
  /** Handoff or "done" line drawn under the reply. */
  footer?: ReactNode;
  /** Marks the card of the participant answering right now. */
  live?: boolean;
  children: ReactNode;
};

/**
 * One participant's turn in the room timeline: a card with that participant's
 * colour down its side and a header that sticks while a long answer scrolls,
 * so it is always clear whose words are on screen.
 */
export default function RoomTurnCard({ participant, header, footer, live, children }: RoomTurnCardProps) {
  return (
    <section
      className={cn(
        'rounded-lg border border-l-4 border-border/50 bg-muted/[0.06]',
        participantColor(participant).bar,
        live && 'ring-1 ring-primary/25',
      )}
    >
      <header className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border/40 bg-background/90 px-3 py-1.5 backdrop-blur">
        {header}
      </header>
      <div className="space-y-2 px-1 py-2 sm:px-2">{children}</div>
      {footer && <footer className="border-t border-border/40 px-3 py-1.5 text-xs">{footer}</footer>}
    </section>
  );
}
