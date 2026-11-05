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
  type Bar,
  type LensState,
  type Span,
} from './tabLens'

const INSET = Number.parseFloat(sizes['size.phone-lens-inset'])
// A longer frame (a hidden page, a stall) counts as this long, so the springs never leap.
const LONGEST_FRAME = 1 / 30

export interface TabLens {
  /** Sends the lens towards `span` from where it is, at its speed. */
  readonly aim: (span: Span) => void
  readonly stop: () => void
}

const settledAt = (state: LensState, span: Span): LensState => ({
  ...state,
  left: { at: span.left, speed: 0 },
  right: { at: span.right, speed: 0 },
})

/** Draws the tab bar's lens on its springs, one frame at a time, sized to the bar. */
export function startTabLens(bar: HTMLElement, lens: HTMLElement, index: number): TabLens {
  let state = restingLens(index)
  let target = restingSpan(index)
  let size: Bar | null = null
  let frame = 0
  let last = 0

  const draw = () => {
    if (!size) return
    const rect = lensRect(size, lensSpan(state))
    lens.style.translate = `${rect.x}px ${rect.y}px`
    lens.style.width = `${rect.width}px`
    lens.style.height = `${rect.height}px`
    lens.style.borderRadius = `${rect.radius}px`
  }

  const tick = (now: number) => {
    const seconds = Math.min(Math.max(now - last, 0) / 1000, LONGEST_FRAME) / motionScale()
    last = now
    state = settleLens(state, target, seconds, PHONE_TABS.length)
    if (lensAtRest(state, target)) {
      state = settledAt(state, target)
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

  const measure = () => {
    size = {
      width: bar.offsetWidth,
      height: bar.offsetHeight,
      inset: INSET,
      count: PHONE_TABS.length,
    }
    draw()
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
        draw()
        return
      }
      state = aimLens(state, span)
      if (frame) return
      last = performance.now()
      frame = requestAnimationFrame(tick)
    },
    stop() {
      observer.disconnect()
      halt()
    },
  }
}
