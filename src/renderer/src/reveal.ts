// A section that opens (a notebook's sub-notebooks, the Status or Tags list)
// grows from nothing to its height (and shrinks away when it closes) over `motion.duration.toggle` on the
// `motion.easing.move` curve, fading in; Reduce Motion shows it at once. Only
// an open the user asked for moves: the first paint never does.
import { motionTiming } from './motionTiming'
import { motionReduced } from './motionPreference'

export function revealTiming(reduced: boolean): KeyframeAnimationOptions | null {
  if (reduced) return null
  return motionTiming('motion.duration.toggle', 'motion.easing.move')
}

export const revealFrames = (height: number): Keyframe[] => [
  { height: '0px', opacity: 0 },
  { height: `${height}px`, opacity: 1 },
]

export const concealFrames = (height: number): Keyframe[] => [...revealFrames(height)].reverse()

export function reveal(el: HTMLElement): void {
  const timing = revealTiming(motionReduced())
  if (!timing || typeof el.animate !== 'function') return
  const overflow = el.style.overflow
  el.style.overflow = 'hidden'
  const growth = el.animate(revealFrames(el.scrollHeight), timing)
  const done = () => {
    el.style.overflow = overflow
  }
  growth.addEventListener('finish', done)
  growth.addEventListener('cancel', done)
}

/**
 * Shrinks `el`, a list that is about to be removed, away, then calls `done`.
 * Calls it at once when nothing should move.
 */
export function conceal(el: HTMLElement | undefined, done: () => void): void {
  const timing = revealTiming(motionReduced())
  if (!el || !timing || typeof el.animate !== 'function') return done()
  el.style.overflow = 'hidden'
  const shrink = el.animate(concealFrames(el.scrollHeight), {
    ...timing,
    fill: 'forwards',
  })
  let called = false
  const end = () => {
    if (called) return
    called = true
    done()
  }
  shrink.addEventListener('finish', end)
  shrink.addEventListener('cancel', end)
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
