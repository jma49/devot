import { sizes } from '../theme/tokens'

const OPEN = Number.parseFloat(sizes['size.phone-swipe-open'])
const ARM = Number.parseFloat(sizes['size.phone-swipe-arm'])
const PEEK_MS = Number.parseFloat(sizes['motion.delay.phone-peek'])
const RUBBER = 0.6
const RIGHTWARD = 0.15
const SLOP = 8
// Points a millisecond: a release faster than this is a flick.
const FLICK = 0.3
const FLICK_MIN_TRAVEL = 24

/** Where a row sits for a drag of `dx` from `base` (0 closed, -OPEN open). */
export function swipeOffset(base: number, dx: number): number {
  const raw = base + dx
  if (raw > 0) return raw * RIGHTWARD
  if (raw < -OPEN) return -OPEN + (raw + OPEN) * RUBBER
  return raw
}

export const isArmed = (offset: number): boolean => offset < -ARM

export type SwipeEnd = 'open' | 'closed' | 'complete'

/** `speed` is rightward points a millisecond at release. */
export function release(offset: number, speed: number): SwipeEnd {
  if (isArmed(offset)) return 'complete'
  if (offset < -OPEN / 2) return speed < FLICK ? 'open' : 'closed'
  return speed < -FLICK && offset < -FLICK_MIN_TRAVEL ? 'open' : 'closed'
}

export type Gesture = 'pending' | 'swipe' | 'scroll' | 'peek'

export function decideGesture(g: {
  dx: number
  dy: number
  heldMs: number
  open: boolean
}): Gesture {
  const ax = Math.abs(g.dx)
  const ay = Math.abs(g.dy)
  if (ax > SLOP && ax > ay) return 'swipe'
  if (ay > SLOP) return 'scroll'
  if (!g.open && g.heldMs >= PEEK_MS) return 'peek'
  return 'pending'
}

export const SWIPE_OPEN = OPEN
export { PEEK_MS }
