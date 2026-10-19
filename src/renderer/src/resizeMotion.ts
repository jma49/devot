// Something that changes size in place (the image viewer between Fit and
// Actual Size, the backlinks opening) eases to it over `motion.duration.grow`
// on the `motion.easing.move` curve. Reduce Motion shows it at once.
import { motionTiming } from './motionTiming'
import { motionReduced } from './motionPreference'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

export function resizeTiming(reduced: boolean): KeyframeAnimationOptions | null {
  if (reduced) return null
  return motionTiming('motion.duration.grow', 'motion.easing.move')
}

/**
 * From `from` to `to`, played on the element laid out at `to`: it starts
 * drawn over `from` (a transform, so nothing else moves) and eases into
 * place. Null when the box did not change.
 */
export function resizeFrames(from: Box, to: Box): Keyframe[] | null {
  if (to.width <= 0 || to.height <= 0) return null
  const sx = from.width / to.width
  const sy = from.height / to.height
  const dx = from.left - to.left
  const dy = from.top - to.top
  if (sx === 1 && sy === 1 && dx === 0 && dy === 0) return null
  return [
    { transformOrigin: '0 0', transform: `matrix(${sx}, 0, 0, ${sy}, ${dx}, ${dy})` },
    { transformOrigin: '0 0', transform: 'none' },
  ]
}

export const expandFrames = (height: number): Keyframe[] => [
  { height: '0px', opacity: 0 },
  { height: `${height}px`, opacity: 1 },
]

export function resizeFrom(el: Element, from: Box): void {
  const timing = resizeTiming(motionReduced())
  const frames = resizeFrames(from, el.getBoundingClientRect())
  if (timing && frames && typeof el.animate === 'function') el.animate(frames, timing)
}

export function expand(el: HTMLElement): void {
  const timing = resizeTiming(motionReduced())
  if (!timing || typeof el.animate !== 'function') return
  el.style.overflow = 'hidden'
  const growth = el.animate(expandFrames(el.scrollHeight), timing)
  const done = () => el.style.removeProperty('overflow')
  growth.addEventListener('finish', done)
  growth.addEventListener('cancel', done)
}
