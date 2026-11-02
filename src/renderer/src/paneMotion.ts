// Hiding or showing the sidebar, or entering or leaving focus mode: a pane
// that goes or comes fades and leaves or takes its room in the layout at
// once; the panes that stay slide from where they were to where they are now
// (measured before and after the change, then played back with the Web
// Animations API) over `motion.duration.slide` on the `motion.easing.move`
// curve. Their size changes at once, and so does the room for the window
// controls; the toolbar items it moves and the note column that focus mode
// centres slide with the panes. A change during another adds to the moves
// under way instead of restarting them. Reduce Motion shows the change at once.
import { motionReduced } from './motionPreference'
import type { Mode } from './ModeControl'
import { type DurationToken, drawnOffset, motionTiming } from './motionTiming'

export const PANES = ['sidebar', 'list', 'content'] as const
export type Pane = (typeof PANES)[number]

export interface PaneBox {
  left: number
  shown: boolean
  opacity?: number
  /** How far a pane fading out is held from its place in the layout. */
  shift?: number
  riders?: Map<Element, number>
}

export type PaneBoxes = Partial<Record<Pane, PaneBox>>

export const shownPanes = (panes: {
  focus: boolean
  sidebarOff: boolean
}): Record<Pane, boolean> => ({
  sidebar: !panes.focus && !panes.sidebarOff,
  list: !panes.focus,
  content: true,
})

export type PaneMove =
  | { kind: 'slide'; dx: number }
  | { kind: 'fade-in'; dx?: number }
  | { kind: 'fade-out'; dx: number }

/**
 * What each pane does from `before` to `after`: one that shows in both
 * slides from its old place, one that comes fades in where it now is (or
 * slides there from where it is still seen fading out), and one that goes
 * fades out where it was. A pane that did not move, or is in only one of
 * them, does nothing.
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
    } else if (is.shown) {
      const seenAt = (was.opacity ?? 0) > 0 ? Math.round(dx + (was.shift ?? 0)) : 0
      moves[pane] = seenAt === 0 ? { kind: 'fade-in' } : { kind: 'fade-in', dx: seenAt }
    } else if (was.shown) moves[pane] = { kind: 'fade-out', dx }
  }
  return moves
}

/**
 * How far each item slides, by how far it moved within its pane, less what
 * `outer` (the item it sits in that slides too, if any) already carries.
 */
export function riderMoves<T>(
  before: Map<T, number>,
  after: Map<T, number>,
  outer: (item: T) => T | undefined = () => undefined,
): Map<T, number> {
  const moved = (item: T) => {
    const was = before.get(item)
    const is = after.get(item)
    return was === undefined || is === undefined ? 0 : Math.round(was - is)
  }
  const moves = new Map<T, number>()
  for (const item of after.keys()) {
    if (!before.has(item)) continue
    const carrier = outer(item)
    const dx = moved(item) - (carrier === undefined ? 0 : moved(carrier))
    if (dx !== 0) moves.set(item, dx)
  }
  return moves
}

export interface PaneAnimation {
  frames: Keyframe[]
  /** Added to the moves under way (`composite: 'add'`) rather than replacing them. */
  add: boolean
  /** Part of the pane's fade, which a later move of the pane stops; a slide always runs out. */
  fade: boolean
}

/** `from`: the pane's opacity now, so a fade cut short turns back where it is. */
export function paneAnimations(move: PaneMove, reduced: boolean, from?: number): PaneAnimation[] {
  if (reduced) return []
  switch (move.kind) {
    case 'slide':
      return [{ frames: slideFrames(move.dx), add: true, fade: false }]
    case 'fade-in': {
      const fade = { frames: [{ opacity: from ?? 0 }, { opacity: 1 }], add: false, fade: true }
      return move.dx ? [fade, { frames: slideFrames(move.dx), add: true, fade: false }] : [fade]
    }
    case 'fade-out': {
      // A hidden pane is out of sight (app.css): it shows while it fades,
      // where it was, and a slide under way carries on under it.
      const fade = {
        frames: [
          { opacity: from ?? 1, visibility: 'visible' },
          { opacity: 0, visibility: 'visible' },
        ],
        add: false,
        fade: true,
      }
      if (move.dx === 0) return [fade]
      const held = { transform: `translateX(${move.dx}px)` }
      return [fade, { frames: [held, held], add: true, fade: true }]
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
  '.list-header .sidebar-toggle, .list-header .toolbar-title > :not([hidden], .visually-hidden), .list-header-end, .editor-toolbar > *, .window > .content > :not(.toolbar)'

const paneElement = (pane: Pane) => document.querySelector<HTMLElement>(`.window > .${pane}`)

const layoutLeft = (el: Element) => el.getBoundingClientRect().left - drawnOffset(el).x

/** Where `el`'s text begins: a padding focus mode adds moves it too. */
const textLeft = (el: Element) =>
  layoutLeft(el) + el.clientLeft + Number.parseFloat(getComputedStyle(el).paddingLeft)

const shows = (el: Element) => el.getClientRects().length > 0

const parentOf = (el: Element): Element | null =>
  el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null)

const fades = new Map<Pane, Animation[]>()
const shifts = new Map<Pane, number>()
const slides: Animation[] = []

function stopFade(pane: Pane): void {
  for (const animation of fades.get(pane) ?? []) animation.cancel()
  fades.delete(pane)
  shifts.delete(pane)
}

export function measurePanes(shown: Record<Pane, boolean>): PaneBoxes {
  const boxes: PaneBoxes = {}
  for (const pane of PANES) {
    const el = paneElement(pane)
    if (!el) continue
    const left = layoutLeft(el)
    const riders = new Map<Element, number>()
    for (const item of el.querySelectorAll(RIDERS))
      if (shows(item)) riders.set(item, textLeft(item) - left)
    // The editor's lines may sit in the middle of it (the readable width
    // setting): the box of its lines and line numbers slides by where the
    // lines move, while the line numbers and the scroll bar stay with the
    // editor.
    for (const host of el.querySelectorAll('.editor')) {
      const scroller = host.shadowRoot?.querySelector('.cm-scroller')
      const lines = scroller?.querySelector(':scope > .cm-content')
      if (scroller && lines && shows(lines)) riders.set(scroller, textLeft(lines) - left)
    }
    boxes[pane] = {
      left,
      shown: shown[pane],
      opacity: Number.parseFloat(getComputedStyle(el).opacity),
      shift: shifts.get(pane) ?? 0,
      riders,
    }
  }
  return boxes
}

export function movePanes(before: PaneBoxes, shown: Record<Pane, boolean>): void {
  const reduced = motionReduced()
  if (reduced) {
    for (const animation of slides.splice(0)) animation.cancel()
    for (const pane of PANES) stopFade(pane)
  }
  const after = measurePanes(shown)
  const moves = paneMoves(before, after)
  const timing = paneTiming()
  const play = (el: Element, part: PaneAnimation, pane: Pane) => {
    if (typeof el.animate !== 'function') return
    const animation = el.animate(part.frames, part.add ? { ...timing, composite: 'add' } : timing)
    const list = part.fade ? (fades.get(pane) ?? []) : slides
    if (part.fade) fades.set(pane, list)
    list.push(animation)
    animation.addEventListener('finish', () => {
      const i = list.indexOf(animation)
      if (i >= 0) list.splice(i, 1)
      if (part.fade && list.length === 0 && fades.get(pane) === list) stopFade(pane)
    })
  }
  for (const pane of PANES) {
    const el = paneElement(pane)
    const move = moves[pane]
    if (move) stopFade(pane)
    if (el && move) {
      for (const part of paneAnimations(move, reduced, before[pane]?.opacity)) play(el, part, pane)
      if (move.kind === 'fade-out' && move.dx !== 0 && !reduced) shifts.set(pane, move.dx)
    }
    const was = before[pane]
    const is = after[pane]
    if (reduced || !el || !was?.shown || !is?.shown || !was.riders || !is.riders) continue
    const riders = is.riders
    const outer = (item: Element) => {
      for (let node = parentOf(item); node && node !== el; node = parentOf(node))
        if (riders.has(node)) return node
      return undefined
    }
    for (const [item, dx] of riderMoves(was.riders, riders, outer)) {
      play(item, { frames: slideFrames(dx), add: true, fade: false }, pane)
      const still = item.querySelector(':scope > .cm-gutters')
      if (still) play(still, { frames: slideFrames(-dx), add: true, fade: false }, pane)
    }
  }
}

export type ModePane = 'editor' | 'preview'
const MODE_PANES: readonly ModePane[] = ['editor', 'preview']
const PANE_ENTER_SHIFT_PX = 40

export const paneEnterFrames = (pane: ModePane): Keyframe[] => [
  {
    opacity: 0,
    transform: `translateX(${pane === 'editor' ? -PANE_ENTER_SHIFT_PX : PANE_ENTER_SHIFT_PX}px)`,
  },
  { opacity: 1, transform: 'translateX(0px)' },
]

export function enteringPanes(from: Mode, to: Mode): ModePane[] {
  const shows = (mode: Mode): ModePane[] =>
    mode === 'split' ? ['editor', 'preview'] : mode === 'edit' ? ['editor'] : ['preview']
  const before = shows(from)
  return shows(to).filter((pane) => !before.includes(pane))
}

const fadeIn = (el: Element | null, duration: DurationToken): void => {
  if (typeof el?.animate !== 'function') return
  el.animate([{ opacity: 0 }, { opacity: 1 }], motionTiming(duration, 'motion.easing.standard'))
}

const modePane = (pane: ModePane) => document.querySelector<HTMLElement>(`.panes > .${pane}`)

export type ModeBoxes = Partial<Record<ModePane, number>>

export function measureModePanes(): ModeBoxes {
  const boxes: ModeBoxes = {}
  for (const pane of MODE_PANES) {
    const el = modePane(pane)
    if (el && shows(el)) boxes[pane] = layoutLeft(el)
  }
  return boxes
}

export function playModeChange(from: Mode, to: Mode, before: ModeBoxes): void {
  const entering = enteringPanes(from, to)
  const reduced = motionReduced()
  const timing = paneTiming()
  for (const pane of MODE_PANES) {
    const el = modePane(pane)
    if (!el || !shows(el) || typeof el.animate !== 'function') continue
    if (entering.includes(pane)) {
      if (reduced) fadeIn(el, 'motion.duration.toggle')
      else el.animate(paneEnterFrames(pane), timing)
      continue
    }
    const was = before[pane]
    const dx = was === undefined ? 0 : Math.round(was - layoutLeft(el))
    if (dx !== 0 && !reduced) el.animate(slideFrames(dx), { ...timing, composite: 'add' })
  }
}

export function fadeInListBody(): void {
  fadeIn(document.querySelector('.list .board-columns, .list .rows'), 'motion.duration.popover')
}
