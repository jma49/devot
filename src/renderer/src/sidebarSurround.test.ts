import { describe, expect, it } from 'vitest'
import { sidebarSurround, surroundFrame } from './sidebarSurround'

const box = { left: 8, top: 8, width: 200.4, height: 683.6 }
const viewport = { width: 1280, height: 820 }

describe('surroundFrame', () => {
  it('measures the sheet cutout where the sidebar is, rounded to whole points', () => {
    expect(surroundFrame(box, { visible: true })).toEqual({
      left: 8,
      top: 8,
      width: 200,
      height: 684,
    })
  })

  it('asks for none while the sidebar is not shown', () => {
    expect(surroundFrame(box, { visible: false })).toBeNull()
    expect(surroundFrame(undefined, { visible: true })).toBeNull()
  })

  it('asks for none for a sidebar with no size (mid layout)', () => {
    expect(surroundFrame({ ...box, width: 0 }, { visible: true })).toBeNull()
    expect(surroundFrame({ ...box, height: 0.3 }, { visible: true })).toBeNull()
  })
})

describe('sidebarSurround', () => {
  it('cuts the rounded sidebar out of the sheet, even-odd', () => {
    const clip = sidebarSurround({ left: 8, top: 8, width: 200, height: 684 }, viewport)
    expect(clip.startsWith("path(evenodd, 'M0 0H1280V820H0Z")).toBe(true)
    expect(clip).toContain('M26 8H190A18 18 0 0 1 208 26')
    expect(clip).toContain('V674A18 18 0 0 1 190 692')
    expect(clip.endsWith("Z')")).toBe(true)
  })
})
