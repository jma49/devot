import type { Box } from './tipPlacement'

export interface DropdownPlacement {
  side: 'below' | 'above'
  shift: number
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

/**
 * Where a dropdown's notch sits along its top or bottom edge: under the middle
 * of its button, or as near as the panel's rounded corners allow.
 */
export function dropdownNotchX(place: {
  anchorWidth: number
  shift: number
  panelWidth: number
  clear: number
}): number {
  const { anchorWidth, shift, panelWidth, clear } = place
  return Math.max(clear, Math.min(anchorWidth / 2 - shift, panelWidth - clear))
}
