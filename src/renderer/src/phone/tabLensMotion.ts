import { motionScale } from '../motionTiming'
import { motionReduced } from '../motionPreference'
import { sizes } from '../theme/tokens'
import { PHONE_TABS } from './navigation'
import {
  aimLens,
  lensAtRest,
  lensRect,
  lensSpan,
  restingLens,
  restingSpan,
  settleLens,
  springStep,
  type Bar,
  type Edge,
  type LensState,
  type Span,
} from './tabLens'

const INSET = Number.parseFloat(sizes['size.phone-lens-inset'])
const LIFT = Number(sizes['motion.scale.phone-lens-lift'])
const LIFT_SPRING = {
  damping: Number(sizes['motion.spring.lift-damping']),
  response: Number(sizes['motion.spring.lift-response']),
}
// A longer frame (a hidden page, a stall) counts as this long, so the springs never leap.
const LONGEST_FRAME = 1 / 30

export interface TabLens {
  /** Sends the lens towards `span` from where it is, at its speed. */
  readonly aim: (span: Span) => void
  /** Grows the lens under a finger, or lets it back down. */
  readonly lift: (on: boolean) => void
  readonly stop: () => void
}

const settledAt = (state: LensState, span: Span): LensState => ({
  ...state,
  left: { at: span.left, speed: 0 },
  right: { at: span.right, speed: 0 },
})

/** Draws the tab bar's lens on its springs, one frame at a time, sized to the bar. */
export function startTabLens(
  bar: HTMLElement,
  lens: HTMLElement,
  index: number,
  onResize: () => void,
): TabLens {
  let state = restingLens(index)
  let target = restingSpan(index)
  let grown: Edge = { at: 0, speed: 0 }
  let grow = 0
  let size: Bar | null = null
  let frame = 0
  let last = 0

  const draw = () => {
    if (!size) return
    const rect = lensRect(size, lensSpan(state), 1 + (LIFT - 1) * grown.at)
    lens.style.translate = `${rect.x}px ${rect.y}px`
    lens.style.width = `${rect.width}px`
    lens.style.height = `${rect.height}px`
    lens.style.borderRadius = `${rect.radius}px`
  }

  const tick = (now: number) => {
    const seconds = Math.min(Math.max(now - last, 0) / 1000, LONGEST_FRAME) / motionScale()
    last = now
    state = settleLens(state, target, seconds, PHONE_TABS.length)
    grown = springStep(grown, grow, LIFT_SPRING, seconds)
    const liftDone = Math.abs(grown.at - grow) < 0.001 && Math.abs(grown.speed) < 0.01
    if (lensAtRest(state, target) && liftDone) {
      state = settledAt(state, target)
      grown = { at: grow, speed: 0 }
      frame = 0
    } else {
      frame = requestAnimationFrame(tick)
    }
    draw()
  }

  const halt = () => {
    cancelAnimationFrame(frame)
    frame = 0
  }

  const run = () => {
    if (frame) return
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }

  const measure = () => {
    const next = {
      width: bar.offsetWidth,
      height: bar.offsetHeight,
      inset: INSET,
      count: PHONE_TABS.length,
    }
    const resized = size !== null && (next.width !== size.width || next.height !== size.height)
    size = next
    draw()
    if (resized) onResize()
  }
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(bar)

  return {
    aim(span) {
      target = span
      if (motionReduced()) {
        halt()
        state = settledAt(state, span)
        grown = { at: 0, speed: 0 }
        draw()
        return
      }
      state = aimLens(state, span)
      run()
    },
    lift(on) {
      grow = on ? 1 : 0
      if (motionReduced()) {
        grown = { at: 0, speed: 0 }
        draw()
        return
      }
      run()
    },
    stop() {
      observer.disconnect()
      halt()
    },
  }
}
