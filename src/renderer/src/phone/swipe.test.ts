import { describe, expect, it } from 'vitest'
import { decideGesture, isArmed, release, swipeActionLook, swipeOffset } from './swipe'

describe('dragging a row', () => {
  it('follows the finger up to the open width', () => {
    expect(swipeOffset(0, -120)).toBe(-120)
    expect(swipeOffset(-196, 40)).toBe(-156)
  })

  it('meets 0.6 rubber band past the open width', () => {
    expect(swipeOffset(0, -296)).toBeCloseTo(-196 - 100 * 0.6)
  })

  it('barely moves to the right of its place', () => {
    expect(swipeOffset(0, 100)).toBeCloseTo(15)
  })

  it('arms the Done action past 270', () => {
    expect(isArmed(-270)).toBe(false)
    expect(isArmed(-271)).toBe(true)
  })

  it('reaches 270 only after about 319 of travel, through the rubber band', () => {
    expect(isArmed(swipeOffset(0, -318))).toBe(false)
    expect(isArmed(swipeOffset(0, -320))).toBe(true)
  })

  it('lets an open row keep its place and close by dragging back', () => {
    expect(swipeOffset(-196, 0)).toBe(-196)
    expect(swipeOffset(-196, 196)).toBeCloseTo(0)
  })
})

describe('the swipe capsules', () => {
  it('shows none at rest', () => {
    for (const index of [0, 1, 2]) expect(swipeActionLook(0, index, 3).grown).toBe(0)
  })

  it('brings in the rightmost first', () => {
    const [pin, trash, done] = [0, 1, 2].map((i) => swipeActionLook(-60, i, 3))
    expect(done!.grown).toBeGreaterThan(trash!.grown)
    expect(trash!.grown).toBeGreaterThan(pin!.grown)
  })

  it('has all three whole by the open width, 52 wide', () => {
    for (const index of [0, 1, 2])
      expect(swipeActionLook(-196, index, 3)).toEqual({
        grown: 1,
        opacity: 1,
        width: 52,
        stretched: false,
      })
  })

  it('stretches Done over the others once armed', () => {
    expect(swipeActionLook(-271, 2, 3)).toMatchObject({ width: 251, stretched: true })
    expect(swipeActionLook(-271, 1, 3)).toMatchObject({ opacity: 0, stretched: false })
    expect(swipeActionLook(-271, 0, 3)).toMatchObject({ opacity: 0, stretched: false })
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

  it('stays open at the width when flung left past half', () => {
    expect(release(-196, -2)).toBe('open')
  })

  it('completes the note once armed, whatever the speed', () => {
    expect(release(-300, 2)).toBe('complete')
    expect(release(-271, -2)).toBe('complete')
    expect(release(-270, 0)).toBe('open')
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

  it('prefers a swipe or a scroll to a hold that moved', () => {
    expect(decideGesture({ dx: -12, dy: 0, heldMs: 500, open: false })).toBe('swipe')
    expect(decideGesture({ dx: 0, dy: 12, heldMs: 500, open: false })).toBe('scroll')
  })

  it('scrolls when the move is an equal diagonal', () => {
    expect(decideGesture({ dx: 12, dy: 12, heldMs: 50, open: false })).toBe('scroll')
  })

  it('peeks after a 420 ms hold, but not on an open row', () => {
    expect(decideGesture({ dx: 2, dy: 2, heldMs: 420, open: false })).toBe('peek')
    expect(decideGesture({ dx: 2, dy: 2, heldMs: 420, open: true })).toBe('pending')
  })
})
