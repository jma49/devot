import { describe, expect, it } from 'vitest'
import { anchorRect, notchOffset } from './toolbarPlacement'

const visible = { left: 0, right: 400, top: 100, bottom: 500 }
const line = (top: number, left = 50) => ({ left, right: left + 8, top, bottom: top + 24 })

describe('anchorRect', () => {
  it('is the start line box, whatever the selection below it', () => {
    expect(anchorRect(line(200), visible)).toEqual({ left: 50, right: 50, top: 200, bottom: 224 })
  })

  it('stays while any part of the start line is in view', () => {
    expect(anchorRect(line(90), visible)).not.toBeNull()
    expect(anchorRect(line(499), visible)).not.toBeNull()
  })

  it('hides when the start scrolled out above or below, or is not drawn', () => {
    expect(anchorRect(line(60), visible)).toBeNull()
    expect(anchorRect(line(500), visible)).toBeNull()
    expect(anchorRect(null, visible)).toBeNull()
  })

  it('hides when the start is scrolled out sideways', () => {
    expect(anchorRect(line(200, -5), visible)).toBeNull()
    expect(anchorRect(line(200, 450), visible)).toBeNull()
  })
})

describe('notchOffset', () => {
  it('points at the anchor when the bar sits where it was asked to', () => {
    expect(notchOffset(113, 100, 300, 13)).toBe(13)
  })

  it('slides along the bar when the bar is held back at the left edge', () => {
    expect(notchOffset(60, 20, 300, 13)).toBe(40)
  })

  it('slides along the bar when the bar is held back at the right edge', () => {
    expect(notchOffset(380, 100, 300, 13)).toBe(280)
  })

  it('stays inside the bar', () => {
    expect(notchOffset(5, 100, 300, 13)).toBe(13)
    expect(notchOffset(900, 100, 300, 13)).toBe(287)
    expect(notchOffset(50, 0, 20, 13)).toBe(13)
  })
})
