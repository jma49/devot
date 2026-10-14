// Where the selection toolbar's anchor and notch go. Pure, so the rules can
// be tested without an editor.
import type { Rect } from '@codemirror/view'

/**
 * The toolbar's anchor: the line box at the selection's start. Null when the
 * start is not drawn or has scrolled out of the visible area, which hides the
 * toolbar (it comes back as the start scrolls back in).
 */
export function anchorRect(start: Rect | null, visible: Rect): Rect | null {
  if (!start) return null
  const outside =
    start.bottom <= visible.top ||
    start.top >= visible.bottom ||
    start.left < visible.left ||
    start.left > visible.right
  return outside
    ? null
    : { left: start.left, right: start.left, top: start.top, bottom: start.bottom }
}

/**
 * How far the notch's middle is from the bar's left edge so it points at the
 * anchor, kept `inset` inside both ends so it stays on the straight edge when
 * the bar is held back at an edge of the editor.
 */
export function notchOffset(anchorX: number, barLeft: number, barWidth: number, inset: number) {
  const max = Math.max(inset, barWidth - inset)
  return Math.min(Math.max(anchorX - barLeft, inset), max)
}
