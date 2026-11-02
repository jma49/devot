import { describe, expect, it } from 'vitest'
import {
  initialNavigation,
  isPhoneLayout,
  layerPlacement,
  navigate,
  releasePops,
  releaseSpeed,
  isAccessibilitySize,
  textScaleFrom,
} from './navigation'

const screens = (state: ReturnType<typeof initialNavigation>, tab = state.tab) =>
  state.stacks[tab].map((route) => route.screen)

describe('choosing the phone layout', () => {
  it('takes an iPhone and leaves the Mac and iPad alone', () => {
    expect(isPhoneLayout('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)')).toBe(true)
    expect(isPhoneLayout('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
    expect(isPhoneLayout('Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X)')).toBe(false)
  })
})

describe('the navigation stacks', () => {
  it('keeps one stack per tab', () => {
    let state = navigate(initialNavigation(), { type: 'push', screen: 'list' })
    state = navigate(state, { type: 'selectTab', tab: 'settings' })
    expect(screens(state)).toEqual(['root'])
    state = navigate(state, { type: 'selectTab', tab: 'library' })
    expect(screens(state)).toEqual(['root', 'list'])
  })

  it('pops to the root when the current tab is tapped', () => {
    let state = navigate(initialNavigation(), { type: 'push', screen: 'list' })
    state = navigate(state, { type: 'push', screen: 'note' })
    state = navigate(state, { type: 'selectTab', tab: state.tab })
    expect(screens(state)).toEqual(['root'])
  })

  it('never pops the root', () => {
    const state = navigate(initialNavigation(), { type: 'pop' })
    expect(screens(state)).toEqual(['root'])
  })

  it('gives each pushed screen its own id', () => {
    let state = navigate(initialNavigation(), { type: 'push', screen: 'list' })
    state = navigate(state, { type: 'pop' })
    const first = state.nextId
    state = navigate(state, { type: 'push', screen: 'list' })
    expect(state.stacks.library[1]?.id).toBe(first)
    expect(state.nextId).toBe(first + 1)
  })
})

describe('a smart tile', () => {
  it("opens the Notes tab at its root with the tile's filter", () => {
    let state = navigate(initialNavigation(), { type: 'selectTab', tab: 'notes' })
    state = navigate(state, { type: 'push', screen: 'note' })
    state = navigate(state, { type: 'selectTab', tab: 'library' })
    state = navigate(state, { type: 'showNotes', view: { kind: 'all' }, status: 'completed' })
    expect(state.tab).toBe('notes')
    expect(screens(state)).toEqual(['root'])
    expect(state.notes).toEqual({ view: { kind: 'all' }, status: 'completed' })
  })

  it('keeps the view a pushed list was opened with', () => {
    const state = navigate(initialNavigation(), {
      type: 'push',
      screen: 'list',
      view: { kind: 'book', id: 'b1' },
    })
    expect(state.stacks.library[1]?.view).toEqual({ kind: 'book', id: 'b1' })
  })
})

describe('a back swipe', () => {
  it('pops past the threshold, or on a fast flick, and springs back otherwise', () => {
    expect(releasePops(111, 0)).toBe(true)
    expect(releasePops(110, 0)).toBe(false)
    expect(releasePops(40, 0.6)).toBe(true)
    expect(releasePops(40, 0.2)).toBe(false)
    expect(releasePops(4, 0.9)).toBe(false)
    expect(releasePops(200, -0.8)).toBe(false)
  })
})

describe('the speed at release', () => {
  it('is the last speed, unless the finger rested first', () => {
    expect(releaseSpeed(0.9, 16)).toBe(0.9)
    expect(releaseSpeed(0.9, 150)).toBe(0)
  })
})

describe('where a layer sits', () => {
  it('puts the top layer under the finger', () => {
    expect(layerPlacement(1, 1, 80, 390).x).toBe('80px')
  })

  it('moves the layer below by 30% and dims it, undoing both as the swipe travels', () => {
    expect(layerPlacement(0, 1, 0, 390)).toMatchObject({ x: '-30vw', dim: 0.1 })
    const half = layerPlacement(0, 1, 195, 390)
    expect(half.x).toBe('-15vw')
    expect(half.dim).toBeCloseTo(0.05)
    expect(layerPlacement(0, 1, 390, 390)).toMatchObject({ x: '0vw', dim: 0 })
  })

  it('keeps deeper layers where they were', () => {
    expect(layerPlacement(0, 2, 195, 390)).toMatchObject({ x: '-30vw', dim: 0.1 })
  })
})

describe('the Dynamic Type scale', () => {
  it('is the body size over the default 17', () => {
    expect(textScaleFrom(17)).toBe(1)
    expect(textScaleFrom(34)).toBe(2)
  })

  it('marks the accessibility sizes, from a 28 point body', () => {
    expect(isAccessibilitySize(textScaleFrom(23))).toBe(false)
    expect(isAccessibilitySize(textScaleFrom(28))).toBe(true)
  })

  it('stays at the default when the size cannot be read', () => {
    expect(textScaleFrom(Number.NaN)).toBe(1)
    expect(textScaleFrom(0)).toBe(1)
  })
})
