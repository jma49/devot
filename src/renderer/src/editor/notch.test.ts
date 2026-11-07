import { describe, expect, it } from 'vitest'
import {
  BAR_GAP,
  BAR_RADIUS,
  EDGE,
  GLASS_BAR_RADIUS,
  NOTCH_WIDTH,
  NOTCH_HEIGHT,
  NOTCH_X,
  highlightBesideNotch,
  notchLeft,
  notchStyles,
} from './notch'
import { notchOffset } from './toolbarPlacement'

const rule = (selector: string) =>
  notchStyles[selector as keyof typeof notchStyles] as Record<string, string>

describe('notch geometry', () => {
  it('is 12 by 6 pixels, and the bar sits one notch height off its anchor', () => {
    expect([NOTCH_WIDTH, NOTCH_HEIGHT]).toEqual([12, 6])
    expect(BAR_GAP).toBe(6)
  })

  it('puts the tip on the anchor at rest, its base clear of either rounded corner', () => {
    expect(BAR_RADIUS).toBe(14)
    expect(GLASS_BAR_RADIUS).toBe(19)
    expect(NOTCH_X).toBe(GLASS_BAR_RADIUS + NOTCH_WIDTH / 2)
    expect(notchLeft(`${NOTCH_X}px`, NOTCH_WIDTH)).toBe('calc(25px - 6px)')
  })

  it('keeps the tip on the anchor when the bar is held back at the window edge', () => {
    expect(notchOffset(40, 0, 300, NOTCH_X)).toBe(40)
    expect(notchOffset(3, 0, 300, NOTCH_X)).toBe(NOTCH_X)
    expect(NOTCH_X - NOTCH_WIDTH / 2).toBeGreaterThanOrEqual(BAR_RADIUS)
    expect(NOTCH_X - NOTCH_WIDTH / 2).toBeGreaterThanOrEqual(GLASS_BAR_RADIUS)
    expect(notchOffset(299, 0, 300, NOTCH_X)).toBe(300 - NOTCH_X)
  })

  it('draws the glass edge as a band and the material as a triangle half a pixel in', () => {
    expect(EDGE).toBe(0.5)
    const edge = rule('.cm-tooltip-above > .cm-float-notch::before')
    const fill = rule('.cm-tooltip-above > .cm-float-notch::after')
    expect(edge.background).toBe('var(--color-line-glass-edge)')
    expect(fill.background).toBe('var(--glass-tint)')
    expect(fill.clipPath).toBe('polygon(0 0, 100% 0, 50% 100%)')
    expect(fill.top).toBe('-0.5px')
    const both = rule('.cm-float-notch::before, .cm-float-notch::after')
    expect([both.width, both.height]).toEqual(['100%', '100%'])
    expect(rule('.cm-float-notch').overflow).toBe('hidden')
    expect(rule('.cm-float-notch').zIndex).toBe('-1')
  })

  it('carries the sheen only on a notch that meets the top edge', () => {
    const fill = rule('.cm-tooltip-below > .cm-float-notch::after')
    expect(fill.background).toBe('var(--glass-sheen-top), var(--glass-tint)')
    expect(fill.bottom).toBe('-0.5px')
  })

  it('clips the edge to its outline, so the translucent material never shows it through', () => {
    // The fill, half a pixel in, crosses the edge triangle's base half a notch width per height in.
    expect(rule('.cm-tooltip-above > .cm-float-notch::before').clipPath).toBe(
      'polygon(0 0, 0.5px 0, 50% calc(100% - 0.5px), calc(100% - 0.5px) 0, 100% 0, 50% 100%)',
    )
    expect(rule('.cm-tooltip-below > .cm-float-notch::before').clipPath).toBe(
      'polygon(0 100%, 0.5px 100%, 50% 0.5px, calc(100% - 0.5px) 100%, 100% 100%, 50% 0)',
    )
  })

  it('is not a rotated square', () => {
    expect(JSON.stringify(notchStyles)).not.toContain('rotate')
  })

  it('draws the top highlight as two strips beside a notch on the top edge, never across its base', () => {
    expect(highlightBesideNotch('var(--x)', '12px')).toBe(
      [
        'var(--glass-highlight) left top / max(0px, var(--x) - 12px / 2) 1px no-repeat',
        'var(--glass-highlight) right top / max(0px, 100% - var(--x) - 12px / 2) 1px no-repeat',
      ].join(', '),
    )
  })

  it('needs no seam strip: the notch, behind the bar, paints over its rim', () => {
    expect(Object.keys(notchStyles).some((k) => k.includes('.cm-float-bar::after'))).toBe(false)
  })
})
