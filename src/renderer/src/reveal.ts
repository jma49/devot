// A section that opens (a notebook's sub-notebooks, the Status or Tags list)
// grows from nothing to its height (and shrinks away when it closes) over
// `motion.duration.toggle` on the `motion.easing.move` curve, fading in; one
// turned back halfway goes back from where it is. Reduce Motion shows it at
// once. Only an open the user asked for moves: the first paint never does.
import { motionTiming } from './motionTiming'
import { motionReduced } from './motionPreference'

export function revealTiming(reduced: boolean): KeyframeAnimationOptions | null {
  if (reduced) return null
  return motionTiming('motion.duration.toggle', 'motion.easing.move')
}

export interface Extent {
  height: number
  opacity: number
}

export const revealFrames = (
  height: number,
  from: Extent = { height: 0, opacity: 0 },
): Keyframe[] => [
  { height: `${from.height}px`, opacity: from.opacity },
  { height: `${height}px`, opacity: 1 },
]

export const concealFrames = (from: Extent): Keyframe[] => [
  { height: `${from.height}px`, opacity: from.opacity },
  { height: '0px', opacity: 0 },
]

interface Run {
  animation: Animation
  closing: boolean
  overflow: string
}

const runs = new WeakMap<HTMLElement, Run>()

const drawn = (el: HTMLElement): Extent => {
  const style = getComputedStyle(el)
  return {
    height: Number.parseFloat(style.height) || 0,
    opacity: Number.parseFloat(style.opacity) || 0,
  }
}

/** Replaces `el`'s running open or close, from where it is drawn now. */
function retarget(
  el: HTMLElement,
  frames: (from: Extent | undefined) => Keyframe[],
  timing: KeyframeAnimationOptions,
  closing: boolean,
): Run {
  const prior = runs.get(el)
  const from = prior ? drawn(el) : undefined
  // Forgotten before it is cancelled, so its handlers see it was replaced.
  runs.delete(el)
  prior?.animation.cancel()
  const overflow = prior ? prior.overflow : el.style.overflow
  el.style.overflow = 'hidden'
  const animation = el.animate(frames(from), closing ? { ...timing, fill: 'forwards' } : timing)
  const run = { animation, closing, overflow }
  runs.set(el, run)
  return run
}

/**
 * Grows `el` open: from nothing when it has just been added, or back from
 * where a close under way has brought it.
 */
export function reveal(el: HTMLElement): void {
  const timing = revealTiming(motionReduced())
  if (!timing || typeof el.animate !== 'function') return
  if (runs.get(el)?.closing === false) return
  const run = retarget(el, (from) => revealFrames(el.scrollHeight, from), timing, false)
  const done = () => {
    if (runs.get(el) !== run) return
    runs.delete(el)
    el.style.overflow = run.overflow
  }
  run.animation.addEventListener('finish', done)
  run.animation.addEventListener('cancel', done)
}

/**
 * Shrinks `el`, a list that is about to be removed, away from where it is
 * drawn, then calls `done`; at once when nothing should move. A `reveal` of
 * `el` before then turns it back, and `done` is never called.
 */
export function conceal(el: HTMLElement | undefined, done: () => void): void {
  const timing = revealTiming(motionReduced())
  if (!el || !timing || typeof el.animate !== 'function') return done()
  const run = retarget(
    el,
    (from) => concealFrames(from ?? { height: el.scrollHeight, opacity: 1 }),
    timing,
    true,
  )
  const end = () => {
    if (runs.get(el) !== run) return
    runs.delete(el)
    done()
  }
  run.animation.addEventListener('finish', end)
  run.animation.addEventListener('cancel', end)
}

const SLIDE_PX = 80

export const slideFrames = (from: 1 | -1): Keyframe[] => [
  { transform: `translateX(${from * SLIDE_PX}px)`, opacity: 0 },
  { transform: 'none', opacity: 1 },
]

export function slideTiming(reduced: boolean): KeyframeAnimationOptions | null {
  if (reduced) return null
  return motionTiming('motion.duration.slide', 'motion.easing.move')
}

export function slideIn(els: Iterable<Element>, from: 1 | -1): void {
  const timing = slideTiming(motionReduced())
  if (!timing) return
  for (const el of els) if (typeof el.animate === 'function') el.animate(slideFrames(from), timing)
}
