// Hiding or showing the sidebar, or entering or leaving focus mode: a pane
// that goes or comes fades and leaves or takes its room in the layout at
// once; the panes that stay slide from where they were to where they are now
// (measured before and after the change, then played back with the Web
// Animations API) over `motion.duration.slide` on the `motion.easing.move`
// curve. Their size changes at once, and so does the room for the window
// controls; the toolbar items it moves slide with the panes. Reduce Motion
// shows the change at once.
import { motionReduced } from './motionPreference'
import { drawnOffset, motionTiming } from './motionTiming'

/** The window's panes, in their order from the left. */
export const PANES = ['sidebar', 'list', 'content'] as const
export type Pane = (typeof PANES)[number]

/** Where a pane's left edge is in the layout (a move under way left out), and whether it shows. */
export interface PaneBox {
  left: number
  shown: boolean
  opacity?: number
  /** Toolbar items the window controls' room moves, from the pane's left edge. */
  riders?: Map<Element, number>
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

export function riderMoves<T>(before: Map<T, number>, after: Map<T, number>): Map<T, number> {
  const moves = new Map<T, number>()
  for (const [item, left] of after) {
    const was = before.get(item)
    if (was === undefined) continue
    const dx = Math.round(was - left)
    if (dx !== 0) moves.set(item, dx)
  }
  return moves
}

/** `from`: the pane's opacity now, so a fade cut short turns back where it is. */
export function paneFrames(move: PaneMove, reduced: boolean, from?: number): Keyframe[] | null {
  if (reduced) return null
  switch (move.kind) {
    case 'slide':
      return slideFrames(move.dx)
    case 'fade-in':
      return [{ opacity: from ?? 0 }, { opacity: 1 }]
    case 'fade-out': {
      // A hidden pane is out of sight (app.css): it shows while it fades,
      // where it was.
      const transform = move.dx === 0 ? 'none' : `translateX(${move.dx}px)`
      return [
        { opacity: from ?? 1, visibility: 'visible', transform },
        { opacity: 0, visibility: 'visible', transform },
      ]
    }
  }
}

export const slideFrames = (dx: number): Keyframe[] => [
  { transform: `translateX(${dx}px)` },
  { transform: 'translateX(0px)' },
]

export const paneTiming = (): KeyframeAnimationOptions =>
  motionTiming('motion.duration.slide', 'motion.easing.move')

const RIDERS =
  '.list-header .sidebar-toggle, .list-header .toolbar-title > :not([hidden], .visually-hidden), .list-header-end, .editor-toolbar > *'

const paneElement = (pane: Pane) => document.querySelector<HTMLElement>(`.window > .${pane}`)

const layoutLeft = (el: Element) => el.getBoundingClientRect().left - drawnOffset(el).x

const fades: Animation[] = []
const slides: Animation[] = []

export function measurePanes(shown: Record<Pane, boolean>): PaneBoxes {
  const boxes: PaneBoxes = {}
  for (const pane of PANES) {
    const el = paneElement(pane)
    if (!el) continue
    const left = layoutLeft(el)
    const riders = new Map<Element, number>()
    for (const item of el.querySelectorAll(RIDERS)) riders.set(item, layoutLeft(item) - left)
    boxes[pane] = {
      left,
      shown: shown[pane],
      opacity: Number.parseFloat(getComputedStyle(el).opacity),
      riders,
    }
  }
  return boxes
}

/** `before`: measured by `measurePanes` before the window changed. */
export function movePanes(before: PaneBoxes, shown: Record<Pane, boolean>): void {
  for (const animation of fades.splice(0)) animation.cancel()
  const reduced = motionReduced()
  if (reduced) for (const animation of slides.splice(0)) animation.cancel()
  const after = measurePanes(shown)
  const moves = paneMoves(before, after)
  const timing = paneTiming()
  const play = (el: Element, frames: Keyframe[], add: boolean) => {
    if (typeof el.animate !== 'function') return
    const animation = el.animate(frames, add ? { ...timing, composite: 'add' } : timing)
    const list = add ? slides : fades
    list.push(animation)
    animation.addEventListener('finish', () => {
      const i = list.indexOf(animation)
      if (i >= 0) list.splice(i, 1)
    })
  }
  for (const pane of PANES) {
    const el = paneElement(pane)
    const move = moves[pane]
    const frames = move && paneFrames(move, reduced, before[pane]?.opacity)
    if (el && move && frames) play(el, frames, move.kind === 'slide')
    const was = before[pane]
    const is = after[pane]
    if (reduced || !was?.shown || !is?.shown || !was.riders || !is.riders) continue
    for (const [item, dx] of riderMoves(was.riders, is.riders)) play(item, slideFrames(dx), true)
  }
}
