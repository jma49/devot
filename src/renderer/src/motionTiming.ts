// Development builds only: `localStorage['devot.motionScale'] = '5'` slows
// every motion, the stylesheet's too, five times.
import { sizes } from './theme/tokens'

type Token = keyof typeof sizes
export type DurationToken = Extract<Token, `motion.duration.${string}`>
export type EasingToken = Extract<Token, `motion.easing.${string}`>

export const MOTION_SCALE_KEY = 'devot.motionScale'

export const parseMotionScale = (stored: string | null): number => {
  const factor = Number(stored)
  return stored !== null && Number.isFinite(factor) && factor > 0 ? factor : 1
}

export function motionScale(): number {
  if (!import.meta.env.DEV) return 1
  try {
    return parseMotionScale(localStorage.getItem(MOTION_SCALE_KEY))
  } catch {
    return 1
  }
}

export const motionMs = (token: DurationToken, factor = motionScale()): number =>
  Number.parseFloat(sizes[token]) * factor

export const motionTiming = (
  duration: DurationToken,
  easing: EasingToken,
  factor = motionScale(),
): KeyframeAnimationOptions => ({ duration: motionMs(duration, factor), easing: sizes[easing] })

export function scaledDurations(factor: number): [string, string][] {
  if (factor === 1) return []
  return Object.keys(sizes)
    .filter((token): token is DurationToken => token.startsWith('motion.duration.'))
    .map((token) => [`--${token.replaceAll('.', '-')}`, `${motionMs(token, factor)}ms`])
}

export function applyMotionScale(root: { style: Pick<CSSStyleDeclaration, 'setProperty'> }): void {
  for (const [name, value] of scaledDurations(motionScale())) root.style.setProperty(name, value)
}

/**
 * The translation of the moves under way. A new move is measured without it
 * and added (`composite: 'add'`) rather than replacing the old one, which
 * keeps running: no jump, and the speed carries over.
 */
export function drawnOffset(el: Element): { x: number; y: number } {
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none' || typeof DOMMatrixReadOnly !== 'function')
    return { x: 0, y: 0 }
  const m = new DOMMatrixReadOnly(transform)
  return { x: m.m41, y: m.m42 }
}

const SPRING_SAMPLES = 48
const SPRING_REST = 0.002

/** A damped spring (damping ratio under 1, response in seconds) as a CSS `linear()` curve and the time it takes to settle. */
export function springEasing(damping: number, response: number): { easing: string; ms: number } {
  const natural = (2 * Math.PI) / response
  const decay = damping * natural
  const damped = natural * Math.sqrt(1 - damping * damping)
  const seconds = Math.log(1 / SPRING_REST) / decay
  const points = Array.from({ length: SPRING_SAMPLES + 1 }, (_, i) => {
    const t = (seconds * i) / SPRING_SAMPLES
    const left =
      Math.exp(-decay * t) * (Math.cos(damped * t) + (decay / damped) * Math.sin(damped * t))
    return i === SPRING_SAMPLES ? '1' : (1 - left).toFixed(4)
  })
  return { easing: `linear(${points.join(', ')})`, ms: seconds * 1000 }
}

export type SpringToken = 'lift' | 'settle'

export function springTiming(token: SpringToken, factor = motionScale()): KeyframeAnimationOptions {
  const { easing, ms } = springEasing(
    Number(sizes[`motion.spring.${token}-damping`]),
    Number(sizes[`motion.spring.${token}-response`]),
  )
  return { duration: ms * factor, easing }
}
