import { describe, expect, it } from 'vitest'
import { sizes } from '../theme/tokens'
import {
  aimLens,
  dragStarted,
  fingerSpan,
  lensAtRest,
  lensRect,
  lensSpan,
  nearestTab,
  restingLens,
  restingSpan,
  settleLens,
  springStep,
  type Bar,
  type LensRect,
  type LensState,
} from './tabLens'

const px = (token: keyof typeof sizes): number => Number.parseFloat(sizes[token])
const inset = px('size.phone-lens-inset')
const height = px('size.phone-glass-bar')
// The bar beside the compose circle on 375, 390 and 440 pt screens.
const bars: Bar[] = [271, 286, 336].map((width) => ({ width, height, inset, count: 4 }))
const bar = bars[1]!
const FRAME = 1 / 60

function insideInner(rect: LensRect, of: Bar): boolean {
  const slack = 1e-9
  return (
    rect.x >= of.inset - slack &&
    rect.x + rect.width <= of.width - of.inset + slack &&
    rect.y >= of.inset - slack &&
    rect.y + rect.height <= of.height - of.inset + slack
  )
}

function run(from: number, to: number, seconds = 2): LensState[] {
  let state = aimLens(restingLens(from), restingSpan(to))
  const frames = [state]
  for (let t = 0; t < seconds; t += FRAME) {
    state = settleLens(state, restingSpan(to), FRAME, bar.count)
    frames.push(state)
  }
  return frames
}

const width = (state: LensState) => state.right.at - state.left.at

describe('the tab bar lens at rest', () => {
  it('is one tab, inset evenly inside the bar, at every tab of every bar', () => {
    for (const of of bars) {
      const tab = (of.width - of.inset * 2) / of.count
      for (let index = 0; index < of.count; index++) {
        const rect = lensRect(of, restingSpan(index))
        expect(insideInner(rect, of)).toBe(true)
        expect(rect.x).toBeCloseTo(of.inset + index * tab)
        expect(rect.width).toBeCloseTo(tab)
        expect(rect.y).toBe(of.inset)
        expect(of.height - rect.y - rect.height).toBe(of.inset)
      }
      expect(lensRect(of, restingSpan(0)).x).toBe(of.inset)
      const last = lensRect(of, restingSpan(of.count - 1))
      expect(of.width - last.x - last.width).toBeCloseTo(of.inset)
    }
  })

  it('has ends concentric with the bar', () => {
    const rect = lensRect(bar, restingSpan(2))
    expect(rect.radius).toBe(bar.height / 2 - bar.inset)
    expect(rect.radius).toBe(rect.height / 2)
    expect(rect.radius).toBe(px('radius.phone-lens-bar'))
  })

  it('holds a span past the ends inside the bar', () => {
    const rect = lensRect(bar, { left: -0.5, right: 4.7 })
    expect(insideInner(rect, bar)).toBe(true)
    expect(rect.x).toBe(bar.inset)
    expect(rect.x + rect.width).toBeCloseTo(bar.width - bar.inset)
  })

  it('still fits inside the bar when lifted under a finger', () => {
    const lift = Number(sizes['motion.scale.phone-lens-lift'])
    expect(lift).toBeGreaterThan(1)
    for (const of of bars) {
      const rect = lensRect(of, restingSpan(of.count - 1))
      expect(rect.height * lift).toBeLessThanOrEqual(of.height)
      expect((rect.width * (lift - 1)) / 2).toBeLessThanOrEqual(of.inset)
    }
  })
})

describe('the tab bar lens moving', () => {
  it('stretches along its travel by width, stays inside the bar, and settles on one tab', () => {
    for (const [from, to] of [
      [0, 3],
      [3, 0],
      [1, 2],
      [2, 3],
    ] as const) {
      const frames = run(from, to)
      for (const frame of frames)
        expect(insideInner(lensRect(bar, lensSpan(frame)), bar)).toBe(true)
      const widest = Math.max(...frames.map(width))
      expect(widest).toBeGreaterThan(1.15)
      expect(widest).toBeLessThan(Math.abs(to - from) + 1)
      expect(Math.min(...frames.map(width))).toBeGreaterThan(0.97)
      const last = frames.at(-1)!
      expect(lensAtRest(last, restingSpan(to))).toBe(true)
      expect(last.left.at).toBeCloseTo(to, 3)
      expect(last.right.at).toBeCloseTo(to + 1, 3)
    }
  })

  it('leads with the end it travels towards', () => {
    const rightwards = run(0, 3)[10]!
    expect(rightwards.right.at - 1).toBeGreaterThan(rightwards.left.at)
    expect(rightwards.right.at - 1).toBeGreaterThan(0)
    const leftwards = run(3, 0)[10]!
    expect(leftwards.left.at).toBeLessThan(leftwards.right.at - 1)
  })

  it('settles within the platform spring time', () => {
    const frames = run(0, 3)
    const rest = frames.findIndex((frame) => lensAtRest(frame, restingSpan(3)))
    expect(rest * FRAME).toBeLessThan(1.2)
  })

  it('turns back from where it is, at its speed, when the target changes', () => {
    const midway = run(0, 3, 0.15).at(-1)!
    const turned = aimLens(midway, restingSpan(0))
    const next = settleLens(turned, restingSpan(0), FRAME, bar.count)
    expect(turned.left).toEqual(midway.left)
    expect(turned.right).toEqual(midway.right)
    expect(turned.lead).toBe('left')
    expect(Math.abs(next.left.at - midway.left.at)).toBeLessThan(0.15)
    let state = turned
    for (let t = 0; t < 2; t += FRAME) {
      state = settleLens(state, restingSpan(0), FRAME, bar.count)
      expect(insideInner(lensRect(bar, lensSpan(state)), bar)).toBe(true)
    }
    expect(lensAtRest(state, restingSpan(0))).toBe(true)
  })
})

describe('the springs', () => {
  it('a critically damped spring never passes its target', () => {
    let edge = { at: 0, speed: 0 }
    for (let t = 0; t < 2; t += FRAME) {
      edge = springStep(edge, 1, { damping: 1, response: 0.5 }, FRAME)
      expect(edge.at).toBeLessThanOrEqual(1)
    }
    expect(edge.at).toBeCloseTo(1, 3)
  })

  it('an underdamped spring overshoots a little and settles', () => {
    let edge = { at: 0, speed: 0 }
    let peak = 0
    for (let t = 0; t < 2; t += FRAME) {
      edge = springStep(edge, 1, { damping: 0.85, response: 0.35 }, FRAME)
      peak = Math.max(peak, edge.at)
    }
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(1.01)
    expect(edge.at).toBeCloseTo(1, 3)
  })

  it('takes one long step as it takes many short ones', () => {
    const spring = { damping: 0.85, response: 0.35 }
    let small = { at: 0, speed: 0 }
    for (let i = 0; i < 10; i++) small = springStep(small, 1, spring, 0.01)
    const big = springStep({ at: 0, speed: 0 }, 1, spring, 0.1)
    expect(big.at).toBeCloseTo(small.at, 6)
    expect(big.speed).toBeCloseTo(small.speed, 4)
  })
})

describe('dragging the lens', () => {
  const tab = (bar.width - bar.inset * 2) / bar.count

  it('centres one tab under the finger', () => {
    const x = bar.inset + tab * 1.7
    const span = fingerSpan(bar, x)
    expect((span.left + span.right) / 2).toBeCloseTo(1.7)
    expect(span.right - span.left).toBeCloseTo(1)
  })

  it('holds the lens inside the bar past either end', () => {
    expect(fingerSpan(bar, -40)).toEqual({ left: 0, right: 1 })
    expect(fingerSpan(bar, bar.inset + tab * 0.2)).toEqual({ left: 0, right: 1 })
    expect(fingerSpan(bar, bar.width + 40)).toEqual({ left: 3, right: 4 })
  })

  it('snaps to the tab nearest the lens', () => {
    expect(nearestTab(fingerSpan(bar, bar.inset + tab * 0.4), bar.count)).toBe(0)
    expect(nearestTab(fingerSpan(bar, bar.inset + tab * 1.49), bar.count)).toBe(1)
    expect(nearestTab(fingerSpan(bar, bar.inset + tab * 1.51), bar.count)).toBe(1)
    expect(nearestTab(fingerSpan(bar, bar.inset + tab * 2.01), bar.count)).toBe(2)
    expect(nearestTab(fingerSpan(bar, bar.width + 40), bar.count)).toBe(3)
    expect(nearestTab(fingerSpan(bar, -40), bar.count)).toBe(0)
    expect(nearestTab({ left: 2.6, right: 3.9 }, bar.count)).toBe(3)
  })

  it('starts only once the finger has moved past the slop', () => {
    expect(dragStarted(3, 2)).toBe(false)
    expect(dragStarted(-7.9, 0)).toBe(false)
    expect(dragStarted(9, 1)).toBe(true)
    expect(dragStarted(-9, 1)).toBe(true)
    expect(dragStarted(4, 12)).toBe(false)
  })
})
