// Rows that come, go or change places in a list (the sidebar's notebooks and
// tags, the note list) move instead of jumping. Only a change of the list's
// own data animates, and only a small one: opening another view, a section
// growing open, scrolling or a resize never does. Where each row was is
// measured as the change renders (`useRowMotion`), before the window shows
// it, and played back once it is laid out:
// - `slide` (the sidebar): rows that stay slide to their new places; a new
//   row fades in where it is, and one that goes fades out where it was, out
//   of the layout.
// - `grow` (the note list): a new row grows from nothing to its height as it
//   fades in, and one that goes shrinks away in its place, so the rows after
//   it follow; rows that only change order slide to their new places.
// Reduce Motion shows every change at once.
import { useLayoutEffect, useState } from 'react'
import { sizes } from './theme/tokens'

/** What changed between two orders of a list's keys. */
export interface RowChange {
  entered: ReadonlySet<string>
  left: ReadonlySet<string>
  /** The keys in both no longer come in the same order. */
  reordered: boolean
}

/** Whether two orders of keys are the same. */
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

/** Whether a change is one to play: something changed, small enough, and some rows stayed. */
export function playsChange(change: RowChange, kept: number): boolean {
  const moved = change.entered.size + change.left.size
  if (moved === 0 && !change.reordered) return false
  return moved <= MAX_ROW_CHANGES && kept > 0
}

export type RowMotion = 'slide' | 'grow'

const ms = (token: keyof typeof sizes) => Number.parseFloat(sizes[token])

/** How a row moving to a new place moves. */
export const rowMoveTiming = (motion: RowMotion): KeyframeAnimationOptions =>
  motion === 'slide'
    ? { duration: ms('motion.duration.slide'), easing: sizes['motion.easing.slide'] }
    : { duration: ms('motion.duration.reorder'), easing: sizes['motion.easing.slide'] }

/** How a row coming or going comes or goes. */
export const rowEnterTiming = (motion: RowMotion): KeyframeAnimationOptions =>
  motion === 'slide'
    ? { duration: ms('motion.duration.slide'), easing: sizes['motion.easing.slide'] }
    : { duration: ms('motion.duration.insert'), easing: sizes['motion.easing.insert'] }

export const moveFrames = (dy: number): Keyframe[] => [
  { transform: `translateY(${dy}px)` },
  { transform: 'none' },
]

export function enterFrames(motion: RowMotion, height: number): Keyframe[] {
  if (motion === 'slide') return [{ opacity: 0 }, { opacity: 1 }]
  return [
    { opacity: 0, height: '0px' },
    { opacity: 1, height: `${height}px` },
  ]
}

export const leaveFrames = (motion: RowMotion, height: number): Keyframe[] =>
  [...enterFrames(motion, height)].reverse()

interface RowBox {
  el: HTMLElement
  /** Its place in the list's content, scrolling aside. */
  top: number
  rect: DOMRect
  parent: Node | null
  next: Node | null
}

type Snapshot = Map<string, RowBox>

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function snapshot(container: HTMLElement, attr: string): Snapshot {
  const base = container.getBoundingClientRect().top - container.scrollTop
  const rows: Snapshot = new Map()
  for (const el of container.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const key = el.getAttribute(attr)
    if (key === null || el.closest('[data-closing]')) continue
    const rect = el.getBoundingClientRect()
    rows.set(key, {
      el,
      top: rect.top - base,
      rect,
      parent: el.parentNode,
      next: el.nextSibling,
    })
  }
  return rows
}

/** An inert copy of a row that went, left in its place while it goes. */
function leaveCopy(box: RowBox, attr: string, motion: RowMotion): HTMLElement | null {
  const parent = box.parent
  if (!parent?.isConnected) return null
  const copy = box.el.cloneNode(true) as HTMLElement
  // Not a row any more: nothing looks it up by its key.
  copy.removeAttribute(attr)
  for (const node of [copy, ...Array.from(copy.querySelectorAll('[id]'))])
    node.removeAttribute('id')
  copy.dataset['closing'] = 'row'
  copy.setAttribute('aria-hidden', 'true')
  copy.inert = true
  if (motion === 'slide') {
    // Out of the layout, over where it was.
    copy.style.position = 'fixed'
    copy.style.left = `${box.rect.left}px`
    copy.style.top = `${box.rect.top}px`
    copy.style.width = `${box.rect.width}px`
    copy.style.height = `${box.rect.height}px`
    copy.style.margin = '0'
    copy.style.pointerEvents = 'none'
  } else {
    copy.style.overflow = 'hidden'
  }
  parent.insertBefore(copy, box.next?.parentNode === parent ? box.next : null)
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
      if (motion === 'grow') box.el.style.overflow = 'hidden'
      const grow = box.el.animate(enterFrames(motion, box.rect.height), rowEnterTiming(motion))
      if (motion === 'grow') {
        const done = () => box.el.style.removeProperty('overflow')
        grow.addEventListener('finish', done)
        grow.addEventListener('cancel', done)
      }
      continue
    }
    const was = before.get(key)
    // A note list only slides rows that changed order; rows that come or go
    // move the rest by growing and shrinking.
    if (!was || (motion === 'grow' && !change.reordered)) continue
    const dy = Math.round(was.top - box.top)
    if (dy !== 0) box.el.animate(moveFrames(dy), rowMoveTiming(motion))
  }
  for (const key of change.left) {
    const box = before.get(key)
    if (!box || box.el.isConnected) continue
    const copy = leaveCopy(box, attr, motion)
    if (!copy) continue
    const leave = copy.animate(leaveFrames(motion, box.rect.height), {
      ...rowEnterTiming(motion),
      fill: 'forwards',
    })
    const done = () => copy.remove()
    leave.addEventListener('finish', done)
    leave.addEventListener('cancel', done)
  }
}

/**
 * Animates the rows (`[attr]` elements, keyed by its value) in `container()`
 * when `keys`, the list's data in order, changes within one `scope` (a view;
 * another scope is another list).
 */
export function useRowMotion(
  container: () => HTMLElement | null,
  attr: string,
  keys: readonly string[],
  scope: string,
  motion: RowMotion,
): void {
  // What the list shows, and the change to play once it is laid out.
  const [seen, setSeen] = useState<{
    keys: readonly string[]
    scope: string
    play: { el: HTMLElement; before: Snapshot; change: RowChange } | null
  }>({ keys, scope, play: null })
  // Compared by content: an equal list in a new array is no change (and no render).
  if (seen.scope !== scope || !sameKeys(seen.keys, keys)) {
    const el = container()
    let next: { el: HTMLElement; before: Snapshot; change: RowChange } | null = null
    if (el && seen.scope === scope && !reducedMotion()) {
      const change = rowChange(seen.keys, keys)
      // Read while the window still shows the rows where they were.
      if (playsChange(change, keys.length - change.entered.size)) {
        next = { el, before: snapshot(el, attr), change }
      }
    }
    setSeen({ keys, scope, play: next })
  }
  // Once for each change: `seen` is new only then.
  useLayoutEffect(() => {
    if (seen.play) play(seen.play.el, attr, seen.play.before, seen.play.change, motion)
  }, [seen, attr, motion])
}
