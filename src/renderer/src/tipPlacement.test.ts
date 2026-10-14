import { describe, expect, it } from 'vitest'
import { placeTip } from './tipPlacement'

const limits = { gap: 12, edge: 8, arrowInset: 15 }
const view = { width: 800, height: 600 }
const tip = { width: 100, height: 40 }

describe('placeTip', () => {
  it('centres the bubble above the button with the gap', () => {
    const p = placeTip({ left: 300, top: 200, width: 20, height: 20 }, tip, view, limits)
    expect(p).toEqual({ left: 260, top: 148, side: 'above', arrowX: 50 })
  })

  it('flips below only when above has no room and below has more', () => {
    const anchor = { left: 300, top: 30, width: 20, height: 20 }
    const p = placeTip(anchor, tip, view, limits)
    expect(p.side).toBe('below')
    expect(p.top).toBe(62)
  })

  it('stays above when there is exactly the edge margin of room', () => {
    const p = placeTip({ left: 300, top: 60, width: 20, height: 20 }, tip, view, limits)
    expect(p.side).toBe('above')
    expect(p.top).toBe(8)
  })

  it('stays above when neither side has room but above has more', () => {
    const small = { width: 800, height: 80 }
    const p = placeTip({ left: 300, top: 50, width: 20, height: 20 }, tip, small, limits)
    expect(p.side).toBe('above')
  })

  it('clamps 8 px inside the window on the left and keeps the notch on the button', () => {
    const p = placeTip({ left: 0, top: 200, width: 20, height: 20 }, tip, view, limits)
    expect(p.left).toBe(8)
    expect(p.arrowX).toBe(15)
  })

  it('clamps inside the window on the right', () => {
    const p = placeTip({ left: 780, top: 200, width: 20, height: 20 }, tip, view, limits)
    expect(p.left).toBe(692)
    expect(p.arrowX).toBe(85)
  })

  it('keeps the notch at least 15 px from the corners', () => {
    const p = placeTip({ left: 8, top: 200, width: 10, height: 20 }, tip, view, limits)
    expect(p.arrowX).toBe(15)
  })
})
