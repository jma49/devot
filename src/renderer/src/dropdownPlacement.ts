import type { Box } from './tipPlacement'

export interface DropdownPlacement {
  /** Which side of its button the list opens on. */
  side: 'below' | 'above'
  /** How far to move the list sideways from the button's left edge (px). */
  shift: number
  /** The most height the list can have on that side without touching the window margin. */
  room: number
}

/**
 * Places a dropdown list of `panel` size under (or, when it does not fit
 * there and the space above is larger, over) `anchor` in a window of `view`
 * size. It is aligned to the button's left edge, then moved sideways to stay
 * `margin` inside the window; `room` is the height left on the chosen side.
 */
export function placeDropdown(
  anchor: Box,
  panel: Pick<Box, 'width' | 'height'>,
  view: Pick<Box, 'width' | 'height'>,
  limits: { gap: number; margin: number },
): DropdownPlacement {
  const below = view.height - (anchor.top + anchor.height) - limits.gap - limits.margin
  const above = anchor.top - limits.gap - limits.margin
  const side = panel.height > below && above > below ? 'above' : 'below'
  const room = Math.max(0, side === 'above' ? above : below)
  const most = view.width - limits.margin - panel.width
  const left = Math.max(limits.margin, Math.min(anchor.left, most))
  return { side, shift: left - anchor.left, room }
}
