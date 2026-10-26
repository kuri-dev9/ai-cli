import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

/**
 * Below this many pixels a menu is too cramped to be worth opening into, so the
 * anchor flips to the other side of the trigger instead.
 */
const MIN_USABLE_HEIGHT = 160;

/**
 * The floor for `maxHeight` when even the roomier side is tiny. Low enough that
 * the menu still fits on screen and scrolls, rather than overflowing the edge.
 */
const MIN_MENU_HEIGHT = 80;

/**
 * Positions a composer popover beside its trigger, right-aligned to it.
 *
 * It opens upward by default, which is what the composer wants: it sits at the
 * bottom of the window, so there is always room above and none below. Anchoring
 * with `right`/`bottom` rather than `left`/`top` lets the menu grow upward and
 * leftward without measuring itself first, so it never paints in the wrong spot
 * for a frame. The same anchor works on phones because `maxWidth` shrinks the
 * menu instead of letting it run off the left edge.
 *
 * The same menus are also used by strips pinned near the top of the window —
 * the room's participant settings, for one — where opening upward would run the
 * menu off the top edge. When the space above is too small to be usable and
 * there is more of it below, the anchor flips and the menu grows downward.
 */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
    // Upward unless that would be cramped and downward is roomier.
    const opensDownward = spaceAbove < MIN_USABLE_HEIGHT && spaceBelow > spaceAbove;
    setAnchor({
      right,
      ...(opensDownward
        ? { top: rect.bottom + MENU_GAP }
        : { bottom: window.innerHeight - rect.top + MENU_GAP }),
      // The space actually available on the chosen side. Capping it any higher
      // is what used to push the menu off the edge instead of scrolling it.
      maxHeight: Math.max(MIN_MENU_HEIGHT, opensDownward ? spaceBelow : spaceAbove),
      maxWidth: Math.max(200, Math.min(preferredWidth, window.innerWidth - right - VIEWPORT_MARGIN)),
    });
  }, [preferredWidth]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
