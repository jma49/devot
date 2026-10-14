import { describe, expect, it } from 'vitest'
import { BAR_GAP, EDGE, NOTCH_WIDTH, NOTCH_HEIGHT, NOTCH_X, notchLeft, notchStyles } from './notch'
import { notchOffset } from './toolbarPlacement'

const rule = (selector: string) =>
  notchStyles[selector as keyof typeof notchStyles] as Record<string, string>

describe('notch geometry', () => {
  it('is 14 by 7 pixels, and the bar sits one notch height off its anchor', () => {
    expect([NOTCH_WIDTH, NOTCH_HEIGHT]).toEqual([14, 7])
    expect(BAR_GAP).toBe(7)
  })

  it('puts the tip on the anchor at rest: the bar starts a notch width left of it', () => {
    expect(NOTCH_X).toBe(14)
    expect(notchLeft(`${NOTCH_X}px`, NOTCH_WIDTH)).toBe('calc(14px - 7px)')
  })

  it('keeps the tip on the anchor when the bar is held back at the window edge', () => {
    // The bar starts at 0 but the anchor is 40 px in: the tip moves with it.
    expect(notchOffset(40, 0, 300, NOTCH_X)).toBe(40)
    // It stays on the straight edge, not on a rounded corner.
    expect(notchOffset(3, 0, 300, NOTCH_X)).toBe(NOTCH_X)
    expect(notchOffset(299, 0, 300, NOTCH_X)).toBe(300 - NOTCH_X)
  })

  it('draws two zero-size border triangles, the fill one pixel in from the edge one', () => {
    const edge = rule('.cm-tooltip-above > .cm-float-notch::before')
    const fill = rule('.cm-tooltip-above > .cm-float-notch::after')
    expect(edge.borderTop).toBe('7px solid var(--color-line-hairline)')
    expect(fill.borderTop).toBe('7px solid var(--color-surface-popover)')
    expect(fill.top).toBe(`-${EDGE}px`)
    const both = rule('.cm-float-notch::before, .cm-float-notch::after')
    expect([both.width, both.height]).toEqual(['0', '0'])
    expect(both.borderLeft).toBe('7px solid transparent')
    expect(both.borderRight).toBe('7px solid transparent')
    expect(rule('.cm-float-notch').overflow).toBe('hidden')
    expect(rule('.cm-float-notch').zIndex).toBe('-1')
  })

  it('is not a rotated square', () => {
    expect(JSON.stringify(notchStyles)).not.toContain('rotate')
  })

  it('closes the seam with a fill strip over the outline at the notch base', () => {
    const strip = rule('.cm-tooltip.cm-float-bar::after')
    expect(strip.height).toBe('1px')
    expect(strip.width).toBe('12px')
    expect(strip.backgroundColor).toBe('var(--color-surface-popover)')
    expect(Number(strip.zIndex)).toBeGreaterThan(0)
    expect(rule('.cm-tooltip-above.cm-float-bar::after').bottom).toBe('-1px')
    expect(rule('.cm-tooltip-below.cm-float-bar::after').top).toBe('-1px')
  })
})
