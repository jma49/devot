// Where the selection toolbar's anchor and notch go. Pure, so the rules can
// be tested without an editor.
import type { Rect } from '@codemirror/view'

/**
 * The toolbar's anchor: from the top of the selection's start line to the
 * bottom of its last line drawn, at the start's x. The bar goes above it;
 * only where the editor's box has no room above (the first lines) does it go
 * below the whole selection, never over it. Null when the start is not drawn
 * or has scrolled out of the visible area, which hides the bar (it comes back
 * as the start scrolls back in).
 */
export function anchorRect(start: Rect | null, end: Rect | null, visible: Rect): Rect | null {
  if (!start) return null
  const outside =
    start.bottom <= visible.top ||
    start.top >= visible.bottom ||
    start.left < visible.left ||
    start.left > visible.right
  if (outside) return null
  return {
    left: start.left,
    right: start.left,
    top: start.top,
    bottom: Math.max(start.bottom, end?.bottom ?? start.bottom),
  }
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
