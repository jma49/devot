// Rows that come, go or change places in a list (the sidebar's notebooks and
// tags, the note list) move instead of jumping. Only a change of the list's
// own data animates, and only a small one: opening another view, a section
// growing open, scrolling or a resize never does. Where each row was is
// measured as the change renders (`useRowMotion`), before the window shows
// it, and played back once it is laid out:
// rows that stay slide to their new places; a new row fades in where it is,
// and one that goes fades out where it was, out of the layout, from how
// opaque it was and only within what the list shows. `slide` (the
// sidebar) and `grow` (the note list) differ only in how long that fade takes.
// Reduce Motion shows every change at once.
import { useLayoutEffect, useState } from 'react'
import { drawnOffset, motionTiming } from './motionTiming'
import { motionReduced } from './motionPreference'

export interface RowChange {
  entered: ReadonlySet<string>
  left: ReadonlySet<string>
  reordered: boolean
}

export const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a === b || (a.length === b.length && a.every((key, i) => b[i] === key))

/** At most this many rows coming and going animate; more is another list. */
export const MAX_ROW_CHANGES = 8

export function rowChange(before: readonly string[], after: readonly string[]): RowChange {
  const was = new Set(before)
  const is = new Set(after)
  const entered = new Set(after.filter((key) => !was.has(key)))
  const left = new Set(before.filter((key) => !is.has(key)))
  const stayedBefore = before.filter((key) => is.has(key))
  const stayedAfter = after.filter((key) => was.has(key))
  const reordered = stayedBefore.some((key, i) => stayedAfter[i] !== key)
  return { entered, left, reordered }
}

export function playsChange(change: RowChange, kept: number): boolean {
  const moved = change.entered.size + change.left.size
  if (moved === 0 && !change.reordered) return false
  return moved <= MAX_ROW_CHANGES && kept > 0
}

export type RowMotion = 'slide' | 'grow'

export const rowMoveTiming = (): KeyframeAnimationOptions =>
  motionTiming('motion.duration.slide', 'motion.easing.move')

export const rowEnterTiming = (motion: RowMotion): KeyframeAnimationOptions =>
  motionTiming(
    motion === 'slide' ? 'motion.duration.slide' : 'motion.duration.insert',
    'motion.easing.move',
  )

export const moveFrames = (dy: number): Keyframe[] => [
  { transform: `translateY(${dy}px)` },
  { transform: 'translateY(0px)' },
]

export const enterFrames: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }]

/** `from`: how opaque the row is drawn as it goes, so one still fading in never brightens. */
export const leaveFrames = (from = 1): Keyframe[] => [{ opacity: from }, { opacity: 0 }]

export interface Edges {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * The `clip-path` that keeps a box at `box` inside `visible`, both in window
 * coordinates; null when none of it shows.
 */
export function clipInset(box: Edges, visible: Edges): string | null {
  const top = Math.max(0, visible.top - box.top)
  const right = Math.max(0, box.right - visible.right)
  const bottom = Math.max(0, box.bottom - visible.bottom)
  const left = Math.max(0, visible.left - box.left)
  if (box.top + top >= box.bottom - bottom || box.left + left >= box.right - right) return null
  return top || right || bottom || left
    ? `inset(${top}px ${right}px ${bottom}px ${left}px)`
    : 'none'
}

/** Where a child of `parent` can show: the intersection of the clipping boxes from `parent` up. */
function visibleEdges(parent: Element): Edges {
  const edges: Edges = { top: -Infinity, right: Infinity, bottom: Infinity, left: -Infinity }
  for (let node: Element | null = parent; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    const clipsX = style.overflowX !== 'visible'
    const clipsY = style.overflowY !== 'visible'
    if (!clipsX && !clipsY) continue
    const rect = node.getBoundingClientRect()
    if (clipsX) {
      edges.left = Math.max(edges.left, rect.left + node.clientLeft)
      edges.right = Math.min(edges.right, rect.left + node.clientLeft + node.clientWidth)
    }
    if (clipsY) {
      edges.top = Math.max(edges.top, rect.top + node.clientTop)
      edges.bottom = Math.min(edges.bottom, rect.top + node.clientTop + node.clientHeight)
    }
  }
  return edges
}

interface RowBox {
  el: HTMLElement
  top: number
  rect: DOMRect
  parent: Node | null
  next: Node | null
  opacity: number
}

type Snapshot = Map<string, RowBox>

function snapshot(container: HTMLElement, attr: string, leaving?: ReadonlySet<string>): Snapshot {
  const base = container.getBoundingClientRect().top - container.scrollTop
  const rows: Snapshot = new Map()
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const key = el.getAttribute(attr)
    if (key === null || el.closest('[data-closing]')) continue
    const rect = el.getBoundingClientRect()
    rows.set(key, {
      el,
      top: rect.top - drawnOffset(el).y - base,
      rect,
      parent: el.parentNode,
      next: el.nextSibling,
      opacity: leaving?.has(key) ? Number.parseFloat(getComputedStyle(el).opacity) : 1,
    })
  }
  return rows
}

function leaveCopy(box: RowBox, attr: string): HTMLElement | null {
  const parent = box.parent
  if (!(parent instanceof Element) || !parent.isConnected) return null
  const clip = clipInset(box.rect, visibleEdges(parent))
  if (!clip) return null
  const copy = box.el.cloneNode(true) as HTMLElement
  // Not a row any more: nothing looks it up by its key.
  copy.removeAttribute(attr)
  for (const node of [copy, ...Array.from(copy.querySelectorAll('[id]'))])
    node.removeAttribute('id')
  copy.dataset['closing'] = 'row'
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  copy.style.position = 'fixed'
  copy.style.boxSizing = 'border-box'
  copy.style.left = `${box.rect.left}px`
  copy.style.top = `${box.rect.top}px`
  copy.style.width = `${box.rect.width}px`
  copy.style.height = `${box.rect.height}px`
  copy.style.margin = '0'
  copy.style.pointerEvents = 'none'
  copy.style.clipPath = clip
  parent.insertBefore(copy, box.next?.parentNode === parent ? box.next : null)
  // A transformed ancestor, not the window, may place a fixed box.
  const placed = copy.getBoundingClientRect()
  if (placed.left !== box.rect.left || placed.top !== box.rect.top) {
    copy.style.left = `${2 * box.rect.left - placed.left}px`
    copy.style.top = `${2 * box.rect.top - placed.top}px`
  }
  return copy
}

function play(
  container: HTMLElement,
  attr: string,
  before: Snapshot,
  change: RowChange,
  motion: RowMotion,
): void {
  const after = snapshot(container, attr)
  for (const [key, box] of after) {
    if (typeof box.el.animate !== 'function') return
    if (change.entered.has(key)) {
      box.el.animate(enterFrames, rowEnterTiming(motion))
      continue
    }
    const was = before.get(key)
    if (!was) continue
    const dy = Math.round(was.top - box.top)
    if (dy !== 0) box.el.animate(moveFrames(dy), { ...rowMoveTiming(), composite: 'add' })
  }
  for (const key of change.left) {
    const box = before.get(key)
    if (!box || box.el.isConnected) continue
    const copy = leaveCopy(box, attr)
    if (!copy) continue
    const leave = copy.animate(leaveFrames(box.opacity), {
      ...rowEnterTiming(motion),
      fill: 'forwards',
    })
    const done = () => copy.remove()
    leave.addEventListener('finish', done)
    leave.addEventListener('cancel', done)
  }
}

/** Animates the rows (`[attr]` elements keyed by its value) in `container()` when `keys` (the list's data in order) change within one `scope` (a view; another scope is another list). */
export function useRowMotion(
  container: () => HTMLElement | null,
  attr: string,
  keys: readonly string[],
  scope: string,
  motion: RowMotion,
): void {
  const [seen, setSeen] = useState<{
    keys: readonly string[]
    scope: string
    play: { el: HTMLElement; before: Snapshot; change: RowChange } | null
  }>({ keys, scope, play: null })
  // Compared by content: an equal list in a new array is no change (and no render).
  if (seen.scope !== scope || !sameKeys(seen.keys, keys)) {
    const el = container()
    let next: { el: HTMLElement; before: Snapshot; change: RowChange } | null = null
    if (el && seen.scope === scope && !motionReduced()) {
      const change = rowChange(seen.keys, keys)
      // Read while the window still shows the rows where they were.
      if (playsChange(change, keys.length - change.entered.size)) {
        next = { el, before: snapshot(el, attr, change.left), change }
      }
    }
    setSeen({ keys, scope, play: next })
  }
  useLayoutEffect(() => {
    if (seen.play) play(seen.play.el, attr, seen.play.before, seen.play.change, motion)
  }, [seen, attr, motion])
}
