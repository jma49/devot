import { describe, expect, it } from 'vitest'
import { placeDropdown } from './dropdownPlacement'

const view = { width: 800, height: 600 }
const limits = { gap: 4, margin: 8 }
const button = (left: number, top: number) => ({
  left,
  top,
  width: 100,
  height: 22,
})

describe('placeDropdown', () => {
  it('opens below the button, aligned to its left edge, when it fits', () => {
    const p = placeDropdown(button(100, 100), { width: 220, height: 200 }, view, limits)
    expect(p).toEqual({ side: 'below', shift: 0, room: 600 - 122 - 4 - 8 })
  })

  it('opens above when it does not fit below and above has more room', () => {
    const p = placeDropdown(button(100, 500), { width: 220, height: 300 }, view, limits)
    expect(p.side).toBe('above')
    expect(p.room).toBe(500 - 4 - 8)
  })

  it('stays below when neither side fits but below has more room', () => {
    const p = placeDropdown(button(100, 100), { width: 220, height: 900 }, view, limits)
    expect(p.side).toBe('below')
    expect(p.room).toBe(466)
  })

  it('moves sideways to keep the window margin on the right', () => {
    const p = placeDropdown(button(700, 100), { width: 220, height: 100 }, view, limits)
    expect(700 + p.shift + 220).toBe(800 - 8)
  })

  it('keeps the left margin when the list is wider than the window', () => {
    const p = placeDropdown(button(50, 100), { width: 900, height: 100 }, view, limits)
    expect(50 + p.shift).toBe(8)
  })

  it('never reports negative room', () => {
    const p = placeDropdown(
      button(0, 3),
      { width: 10, height: 10 },
      { width: 100, height: 20 },
      limits,
    )
    expect(p.room).toBe(0)
  })
})
