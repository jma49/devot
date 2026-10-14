// A section that opens (a notebook's sub-notebooks, the Status or Tags list)
// grows from nothing to its height (and shrinks away when it closes) over `motion.duration.toggle` on the
// `motion.easing.out` curve, fading in; Reduce Motion shows it at once. Only
// an open the user asked for moves: the first paint never does.
import { sizes } from './theme/tokens'

/** The timing of the growth, or null when nothing should move. */
export function revealTiming(reduced: boolean): KeyframeAnimationOptions | null {
  if (reduced) return null
  return {
    duration: Number.parseFloat(sizes['motion.duration.toggle']),
    easing: sizes['motion.easing.out'],
  }
}

/** From nothing to `height` pixels, fading in. */
export const revealFrames = (height: number): Keyframe[] => [
  { height: '0px', opacity: 0 },
  { height: `${height}px`, opacity: 1 },
]

/** From `height` pixels to nothing, fading out. */
export const concealFrames = (height: number): Keyframe[] => [...revealFrames(height)].reverse()

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Grows `el`, a list that has just been shown, to its height. */
export function reveal(el: HTMLElement): void {
  const timing = revealTiming(reducedMotion())
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
  const timing = revealTiming(reducedMotion())
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
