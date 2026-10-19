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
