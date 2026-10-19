// Hiding or showing the sidebar, or entering or leaving focus mode: a pane
// that goes or comes fades and leaves or takes its room in the layout at
// once; the panes that stay slide from where they were to where they are now
// (measured before and after the change, then played back with the Web
// Animations API) over `motion.duration.slide` on the `motion.easing.slide`
// curve. Their size changes at once. Reduce Motion shows the change at once.
import { sizes } from './theme/tokens'
import { motionReduced } from './motionPreference'

/** The window's panes, in their order from the left. */
export const PANES = ['sidebar', 'list', 'content'] as const
export type Pane = (typeof PANES)[number]

/** Where a pane's left edge is on screen, and whether it shows. */
export interface PaneBox {
  left: number
  shown: boolean
}

export type PaneBoxes = Partial<Record<Pane, PaneBox>>

/** Which panes show: focus mode hides the sidebar and the list, the toggle the sidebar. */
export const shownPanes = (panes: {
  focus: boolean
  sidebarOff: boolean
}): Record<Pane, boolean> => ({
  sidebar: !panes.focus && !panes.sidebarOff,
  list: !panes.focus,
  content: true,
})

/** What a pane does across a change. */
export type PaneMove =
  | { kind: 'slide'; dx: number }
  | { kind: 'fade-in' }
  | { kind: 'fade-out'; dx: number }

/**
 * What each pane does from `before` to `after`: one that shows in both
 * slides from its old place, one that comes fades in where it now is, and
 * one that goes fades out where it was. A pane that did not move, or is in
 * only one of them, does nothing.
 */
export function paneMoves(before: PaneBoxes, after: PaneBoxes): Partial<Record<Pane, PaneMove>> {
  const moves: Partial<Record<Pane, PaneMove>> = {}
  for (const pane of PANES) {
    const was = before[pane]
    const is = after[pane]
    if (!was || !is) continue
    const dx = Math.round(was.left - is.left)
    if (was.shown && is.shown) {
      if (dx !== 0) moves[pane] = { kind: 'slide', dx }
    } else if (is.shown) moves[pane] = { kind: 'fade-in' }
    else if (was.shown) moves[pane] = { kind: 'fade-out', dx }
  }
  return moves
}

/** The keyframes of a move; none under Reduce Motion (the change shows at once). */
export function paneFrames(move: PaneMove, reduced: boolean): Keyframe[] | null {
  if (reduced) return null
  switch (move.kind) {
    case 'slide':
      return [{ transform: `translateX(${move.dx}px)` }, { transform: 'none' }]
    case 'fade-in':
      return [{ opacity: 0 }, { opacity: 1 }]
    case 'fade-out': {
      // A hidden pane is out of sight (app.css): it shows while it fades,
      // where it was.
      const transform = move.dx === 0 ? 'none' : `translateX(${move.dx}px)`
      return [
        { opacity: 1, visibility: 'visible', transform },
        { opacity: 0, visibility: 'visible', transform },
      ]
    }
  }
}

export const paneTiming: KeyframeAnimationOptions = {
  duration: Number.parseFloat(sizes['motion.duration.slide']),
  easing: sizes['motion.easing.slide'],
}

const paneElement = (pane: Pane) => document.querySelector<HTMLElement>(`.window > .${pane}`)

/** The moves under way, stopped when another change comes. */
const running: Animation[] = []

/** Where the panes are now, as they look (a slide under way included). */
export function measurePanes(shown: Record<Pane, boolean>): PaneBoxes {
  const boxes: PaneBoxes = {}
  for (const pane of PANES) {
    const el = paneElement(pane)
    if (el)
      boxes[pane] = {
        left: el.getBoundingClientRect().left,
        shown: shown[pane],
      }
  }
  return boxes
}

/**
 * Plays the change from `before` (measured with `measurePanes` before the
 * window changed) to the panes as they are now. A move still under way
 * stops first, so the new one starts from where the pane was seen.
 */
export function movePanes(before: PaneBoxes, shown: Record<Pane, boolean>): void {
  for (const animation of running.splice(0)) animation.cancel()
  const moves = paneMoves(before, measurePanes(shown))
  const reduced = motionReduced()
  for (const pane of PANES) {
    const el = paneElement(pane)
    const move = moves[pane]
    const frames = move && paneFrames(move, reduced)
    if (frames && typeof el?.animate === 'function') running.push(el.animate(frames, paneTiming))
  }
}
