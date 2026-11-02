import { sizes } from '../theme/tokens'

const OPEN = Number.parseFloat(sizes['size.phone-swipe-open'])
const ARM = Number.parseFloat(sizes['size.phone-swipe-arm'])
const PEEK_MS = Number.parseFloat(sizes['motion.delay.phone-peek'])
const ACTION = Number.parseFloat(sizes['size.phone-swipe-action'])
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

export interface SwipeActionLook {
  readonly grown: number
  readonly opacity: number
  readonly width: number
  readonly stretched: boolean
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
const ACTION_STAGGER = 0.12
const ACTION_SPAN = 0.76
const STRETCH_MARGIN = 20
const HIDDEN_SCALE = 0.2

/** How action `index` of `count` looks at `offset`: the rightmost comes first, and once armed it takes over. */
export function swipeActionLook(offset: number, index: number, count: number): SwipeActionLook {
  const armed = isArmed(offset)
  const last = index === count - 1
  if (armed && !last) return { grown: HIDDEN_SCALE, opacity: 0, width: ACTION, stretched: false }
  const progress = Math.min(2, Math.max(0, -offset / OPEN))
  const shown = clamp01((progress - (count - 1 - index) * ACTION_STAGGER) / ACTION_SPAN)
  return {
    grown: shown,
    opacity: Math.min(1, shown * 1.6),
    width: armed ? Math.max(ACTION, -offset - STRETCH_MARGIN) : ACTION,
    stretched: armed,
  }
}

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
