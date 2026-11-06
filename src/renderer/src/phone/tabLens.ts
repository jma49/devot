import { sizes } from '../theme/tokens'
import { clamp } from '../clamp'

export interface Bar {
  readonly width: number
  readonly height: number
  readonly inset: number
  readonly count: number
}

/** The lens's ends in tabs from the bar's inner left edge: tab `i` at rest is `i` to `i + 1`. */
export interface Span {
  readonly left: number
  readonly right: number
}

export interface LensRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
}

export interface Edge {
  readonly at: number
  readonly speed: number
}

export interface LensState {
  readonly left: Edge
  readonly right: Edge
  readonly lead: 'left' | 'right'
}

export interface Spring {
  readonly damping: number
  readonly response: number
}

const SLOP = 8
const REST_AT = 0.001
const REST_SPEED = 0.01

const spring = (name: 'lead' | 'trail'): Spring => ({
  damping: Number(sizes[`motion.spring.phone-lens-${name}-damping`]),
  response: Number(sizes[`motion.spring.phone-lens-${name}-response`]),
})
const LEAD = spring('lead')
const TRAIL = spring('trail')

export const restingSpan = (index: number): Span => ({ left: index, right: index + 1 })

/**
 * The lens drawn for `span`, grown by `lift` about its middle. Lifted, it keeps the margin it has
 * at top and bottom from the bar's ends too, so it stays concentric with the bar at the first and
 * last tab and never leaves it.
 */
export function lensRect(bar: Bar, span: Span, lift = 1): LensRect {
  const tab = (bar.width - bar.inset * 2) / bar.count
  const left = clamp(span.left, 0, bar.count)
  const right = clamp(span.right, left, bar.count)
  const restHeight = bar.height - bar.inset * 2
  const margin = Math.max(0, bar.inset - (restHeight * (Math.max(lift, 1) - 1)) / 2)
  const middle = bar.inset + ((left + right) / 2) * tab
  const half = ((right - left) * tab * Math.max(lift, 1)) / 2
  const x = Math.max(margin, middle - half)
  const end = Math.min(bar.width - margin, middle + half)
  const height = bar.height - margin * 2
  return { x, y: margin, width: end - x, height, radius: height / 2 }
}

/** One tab centred under a finger `x` points from the bar's left edge, held inside the bar. */
export function fingerSpan(bar: Bar, x: number): Span {
  const tab = (bar.width - bar.inset * 2) / bar.count
  const left = clamp((x - bar.inset) / tab - 0.5, 0, bar.count - 1)
  return { left, right: left + 1 }
}

export function nearestTab(span: Span, count: number): number {
  return clamp(Math.floor((span.left + span.right) / 2), 0, count - 1)
}

export const dragStarted = (dx: number, dy: number): boolean =>
  Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)

/** Where a damped spring from `edge` towards `target` is `seconds` later, solved exactly. */
export function springStep(
  edge: Edge,
  target: number,
  { damping, response }: Spring,
  seconds: number,
): Edge {
  const natural = (2 * Math.PI) / response
  const offset = edge.at - target
  const decay = Math.exp(-damping * natural * seconds)
  if (damping >= 1) {
    const b = edge.speed + natural * offset
    return {
      at: target + decay * (offset + b * seconds),
      speed: decay * (edge.speed - natural * b * seconds),
    }
  }
  const damped = natural * Math.sqrt(1 - damping * damping)
  const cos = Math.cos(damped * seconds)
  const sin = Math.sin(damped * seconds)
  return {
    at:
      target + decay * (offset * cos + ((edge.speed + damping * natural * offset) / damped) * sin),
    speed:
      decay *
      (edge.speed * cos -
        ((damping * natural * edge.speed + natural * natural * offset) / damped) * sin),
  }
}

export const restingLens = (index: number): LensState => ({
  left: { at: index, speed: 0 },
  right: { at: index + 1, speed: 0 },
  lead: 'right',
})

export const lensSpan = (state: LensState): Span => ({
  left: state.left.at,
  right: state.right.at,
})

/** Points the lens at a new target: the end it travels towards leads. */
export function aimLens(state: LensState, target: Span): LensState {
  const from = state.left.at + state.right.at
  const to = target.left + target.right
  if (to === from) return state
  return { ...state, lead: to > from ? 'right' : 'left' }
}

const held = (edge: Edge, count: number): Edge => {
  const at = clamp(edge.at, 0, count)
  return at === edge.at ? edge : { at, speed: 0 }
}

export function settleLens(
  state: LensState,
  target: Span,
  seconds: number,
  count: number,
): LensState {
  const leftSpring = state.lead === 'left' ? LEAD : TRAIL
  const rightSpring = state.lead === 'right' ? LEAD : TRAIL
  const left = held(springStep(state.left, target.left, leftSpring, seconds), count)
  const right = held(springStep(state.right, target.right, rightSpring, seconds), count)
  if (right.at >= left.at) return { ...state, left, right }
  const at = (left.at + right.at) / 2
  return { ...state, left: { at, speed: 0 }, right: { at, speed: 0 } }
}

const settled = (edge: Edge, to: number) =>
  Math.abs(edge.at - to) < REST_AT && Math.abs(edge.speed) < REST_SPEED

export const lensAtRest = (state: LensState, target: Span): boolean =>
  settled(state.left, target.left) && settled(state.right, target.right)
