import { clamp } from './clamp'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface TipPlacement {
  left: number
  top: number
  side: 'above' | 'below'
  arrowX: number
}

export interface TipLimits {
  gap: number
  edge: number
  arrowInset: number
}

/** Within `min` and `max`; `min` wins when the tip is wider than the room. */
const fit = (value: number, min: number, max: number) => clamp(value, min, Math.max(min, max))

/**
 * Places a tooltip bubble of `tip` size next to `anchor` in a window of
 * `view` size: above the button, centred on it; below only when the space
 * above is under the edge margin and below has more room. The bubble is kept
 * `edge` inside the window, and the notch keeps pointing at the button's
 * centre, at least `arrowInset` from the bubble's corners.
 */
export function placeTip(
  anchor: Box,
  tip: Pick<Box, 'width' | 'height'>,
  view: Pick<Box, 'width' | 'height'>,
  limits: TipLimits,
): TipPlacement {
  const above = anchor.top - limits.gap - tip.height
  const below = view.height - (anchor.top + anchor.height) - limits.gap - tip.height
  const side = above < limits.edge && below > above ? 'below' : 'above'
  const top = side === 'above' ? above : anchor.top + anchor.height + limits.gap
  const centre = anchor.left + anchor.width / 2
  const left = fit(centre - tip.width / 2, limits.edge, view.width - limits.edge - tip.width)
  const arrowX = fit(centre - left, limits.arrowInset, tip.width - limits.arrowInset)
  return { left, top, side, arrowX }
}
