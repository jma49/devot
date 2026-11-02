import { describe, expect, it } from 'vitest'
import { decideGesture, isArmed, release, swipeOffset } from './swipe'

describe('dragging a row', () => {
  it('follows the finger up to the open width', () => {
    expect(swipeOffset(0, -120)).toBe(-120)
    expect(swipeOffset(-190, 40)).toBe(-150)
  })

  it('meets 0.6 rubber band past the open width', () => {
    expect(swipeOffset(0, -290)).toBeCloseTo(-190 - 100 * 0.6)
  })

  it('barely moves to the right of its place', () => {
    expect(swipeOffset(0, 100)).toBeCloseTo(15)
  })

  it('arms the Done action past 280', () => {
    expect(isArmed(-280)).toBe(false)
    expect(isArmed(-281)).toBe(true)
  })
})

describe('letting go of a row', () => {
  it('opens past half the open width when it is not flung back', () => {
    expect(release(-100, 0)).toBe('open')
    expect(release(-100, 0.6)).toBe('closed')
  })

  it('closes short of half, unless flicked left', () => {
    expect(release(-60, 0)).toBe('closed')
    expect(release(-60, -0.5)).toBe('open')
    expect(release(-10, -0.9)).toBe('closed')
  })

  it('completes the note once armed, whatever the speed', () => {
    expect(release(-300, 2)).toBe('complete')
  })
})

describe('telling a press, a swipe and a scroll apart', () => {
  it('waits while the finger has barely moved', () => {
    expect(decideGesture({ dx: 3, dy: 4, heldMs: 100, open: false })).toBe('pending')
  })

  it('swipes on a mostly horizontal move', () => {
    expect(decideGesture({ dx: -12, dy: 5, heldMs: 50, open: false })).toBe('swipe')
  })

  it('scrolls on a vertical move, so a scroll never starts a swipe', () => {
    expect(decideGesture({ dx: 9, dy: 14, heldMs: 50, open: false })).toBe('scroll')
  })

  it('peeks after a 420 ms hold, but not on an open row', () => {
    expect(decideGesture({ dx: 2, dy: 2, heldMs: 420, open: false })).toBe('peek')
    expect(decideGesture({ dx: 2, dy: 2, heldMs: 420, open: true })).toBe('pending')
  })
})
