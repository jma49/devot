import { describe, expect, it } from 'vitest'
import { glassFrame, sameFrame, showNativeGlass } from './sidebarGlass'

const box = { left: 8, top: 8, width: 200.4, height: 683.6 }

describe('glassFrame', () => {
  it('asks for glass where the sidebar is, rounded to whole points, with the sidebar radius', () => {
    expect(glassFrame(box, { material: true, visible: true })).toEqual({
      x: 8,
      y: 8,
      width: 200,
      height: 684,
      radius: 18,
    })
  })

  it('asks for none while the window material is off or the sidebar is not shown', () => {
    expect(glassFrame(box, { material: false, visible: true })).toBeNull()
    expect(glassFrame(box, { material: true, visible: false })).toBeNull()
    expect(glassFrame(undefined, { material: true, visible: true })).toBeNull()
  })

  it('asks for none for a sidebar with no size (mid layout)', () => {
    expect(glassFrame({ ...box, width: 0 }, { material: true, visible: true })).toBeNull()
    expect(glassFrame({ ...box, height: 0.3 }, { material: true, visible: true })).toBeNull()
  })
})

describe('sameFrame', () => {
  it('tells an unchanged request apart from a new one', () => {
    const frame = glassFrame(box, { material: true, visible: true })
    expect(sameFrame(frame, { ...frame! })).toBe(true)
    expect(sameFrame(frame, { ...frame!, width: 240 })).toBe(false)
    expect(sameFrame(null, null)).toBe(true)
    expect(sameFrame(undefined, null)).toBe(false)
    expect(sameFrame(frame, null)).toBe(false)
  })
})

describe('showNativeGlass', () => {
  it('marks the root only while the system draws the glass', () => {
    const root = { dataset: {} as Record<string, string | undefined> }
    showNativeGlass(root, true)
    expect(root.dataset['nativeGlass']).toBe('on')
    showNativeGlass(root, false)
    expect(root.dataset['nativeGlass']).toBeUndefined()
  })
})
