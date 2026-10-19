import { describe, expect, it } from 'vitest'
import { expandFrames, resizeFrames, resizeTiming } from './resizeMotion'

describe('a size change', () => {
  it('moves over 300 ms on the move curve, and not under Reduce Motion', () => {
    expect(resizeTiming(false)).toEqual({
      duration: 300,
      easing: 'cubic-bezier(0.38, 0.7, 0.125, 1)',
    })
    expect(resizeTiming(true)).toBeNull()
  })

  it('starts drawn over the old box and eases into the new one', () => {
    expect(
      resizeFrames(
        { left: 100, top: 50, width: 200, height: 100 },
        { left: 0, top: 0, width: 400, height: 400 },
      ),
    ).toEqual([
      { transformOrigin: '0 0', transform: 'matrix(0.5, 0, 0, 0.25, 100, 50)' },
      { transformOrigin: '0 0', transform: 'none' },
    ])
  })

  it('does nothing for a box that did not change or has no size', () => {
    const box = { left: 0, top: 0, width: 10, height: 10 }
    expect(resizeFrames(box, box)).toBeNull()
    expect(resizeFrames(box, { ...box, width: 0 })).toBeNull()
  })

  it('opens a panel from nothing to its height, fading in', () => {
    expect(expandFrames(48)).toEqual([
      { height: '0px', opacity: 0 },
      { height: '48px', opacity: 1 },
    ])
  })
})
