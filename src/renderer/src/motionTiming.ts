// How long a motion plays and on what curve, from the design tokens. Every
// motion the code plays reads its timing here, and the stylesheet's from the
// `--motion-duration-*` variables, so one factor slows them all: in a
// development build, `localStorage['devot.motionScale'] = '5'` plays every
// motion five times slower, to watch it closely. Release builds ignore it.
import { sizes } from './theme/tokens'

type Token = keyof typeof sizes
export type DurationToken = Extract<Token, `motion.duration.${string}`>
export type EasingToken = Extract<Token, `motion.easing.${string}`>

export const MOTION_SCALE_KEY = 'devot.motionScale'

/** A stored factor as a usable one: a positive number, else 1. */
export const parseMotionScale = (stored: string | null): number => {
  const factor = Number(stored)
  return stored !== null && Number.isFinite(factor) && factor > 0 ? factor : 1
}

/** How many times slower than designed every motion plays (1 outside development). */
export function motionScale(): number {
  if (!import.meta.env.DEV) return 1
  try {
    return parseMotionScale(localStorage.getItem(MOTION_SCALE_KEY))
  } catch {
    return 1
  }
}

/** A duration token in milliseconds, slowed by the factor. */
export const motionMs = (token: DurationToken, factor = motionScale()): number =>
  Number.parseFloat(sizes[token]) * factor

/** The Web Animations timing of a motion. */
export const motionTiming = (
  duration: DurationToken,
  easing: EasingToken,
  factor = motionScale(),
): KeyframeAnimationOptions => ({ duration: motionMs(duration, factor), easing: sizes[easing] })

/** The stylesheet's durations slowed by `factor`, as variables to set on the root. */
export function scaledDurations(factor: number): [string, string][] {
  if (factor === 1) return []
  return Object.keys(sizes)
    .filter((token): token is DurationToken => token.startsWith('motion.duration.'))
    .map((token) => [`--${token.replaceAll('.', '-')}`, `${motionMs(token, factor)}ms`])
}

/** Slows the stylesheet's motion on `root` by the stored factor. Once per page. */
export function applyMotionScale(root: { style: Pick<CSSStyleDeclaration, 'setProperty'> }): void {
  for (const [name, value] of scaledDurations(motionScale())) root.style.setProperty(name, value)
}

/**
 * How far `el` is drawn from its place in the layout by the moves under way
 * (their transforms), in pixels. A move that comes while another is under way
 * starts from the place in the layout less this and adds to the one under way
 * (`composite: 'add'`) instead of stopping it, so the thing never jumps or
 * loses its speed: the old move goes on to its end while the new one carries
 * it to the new place.
 */
export function drawnOffset(el: Element): { x: number; y: number } {
  const transform = getComputedStyle(el).transform
  if (!transform || transform === 'none' || typeof DOMMatrixReadOnly !== 'function')
    return { x: 0, y: 0 }
  const m = new DOMMatrixReadOnly(transform)
  return { x: m.m41, y: m.m42 }
}
