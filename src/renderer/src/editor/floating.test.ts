import { describe, expect, it } from 'vitest'
import { floatStyles, placeFloatTip } from './floating'
import { EDGE, NOTCH_HEIGHT, NOTCH_WIDTH, highlightBesideNotch, notchStyles } from './notch'

type Rule = Record<string, string>
const rule = (selector: string) => floatStyles[selector] as Rule

describe('floating bar motion and states', () => {
  it('shows hover and pressed the same way: an outline ring over a fill', () => {
    const hover = rule('.cm-float-button:hover:not(:disabled)')
    const pressed = rule('.cm-float-button[aria-pressed="true"]')
    for (const state of [hover, pressed]) {
      expect(state.borderColor).toBe('var(--color-line-control)')
      expect(state.backgroundColor).toBe('var(--color-fill-tool-hover)')
    }
    // At rest the ring is there but clear, so it can ease in.
    expect(rule('.cm-float-button').border).toBe('1px solid transparent')
  })

  it('eases the colour and the ring, and snaps the fill', () => {
    const transition = rule('.cm-float-button').transition
    expect(transition).toContain('color var(--motion-duration-color) var(--motion-easing-standard)')
    expect(transition).toContain(
      'border-color var(--motion-duration-ring) var(--motion-easing-out)',
    )
    expect(transition).not.toContain('background')
  })

  it('is one element: the glass material, the glass rim and one soft box shadow layer, no filter and no animation', () => {
    const bar = rule('.cm-tooltip.cm-float-bar')
    expect(bar.outline).toBeUndefined()
    expect(bar.boxShadow).toMatch(/^var\(--glass-rim\), /)
    expect(bar.border).toBe('0')
    expect(bar.background).toBe('var(--glass-material-bg)')
    expect(bar.boxShadow!.split('), ')).toHaveLength(2)
    expect(bar.boxShadow).toContain('var(--color-shadow-float-bar)')
    expect(bar.boxShadow).not.toContain('popover')
    expect(bar.filter).toBeUndefined()
    expect(bar.animation).toBeUndefined()
    expect(floatStyles['@keyframes cm-fade-in']).toEqual({
      from: { opacity: '0' },
    })
  })

  it('blurs what is under the bar and its tooltip', () => {
    for (const selector of ['.cm-tooltip.cm-float-bar', '.cm-float-tip']) {
      const surface = rule(selector)
      expect(surface.backdropFilter).toBe('var(--glass-backdrop, none)')
      expect(surface.WebkitBackdropFilter).toBe('var(--glass-backdrop, none)')
    }
  })

  it('has zero-width separators with a left border and buttons with no gap', () => {
    const separator = rule('.cm-float-separator')
    expect(separator.width).toBe('0')
    expect(separator.borderLeft).toBe('1px solid var(--color-line-separator)')
    expect(rule('.cm-float-buttons').gap).toBeUndefined()
    expect(separator.height).toBe('var(--size-float-separator-height)')
  })

  it('is a near pill', async () => {
    const { BAR_RADIUS } = await import('./notch')
    const { sizes } = await import('../theme/tokens')
    const height = Number.parseFloat(sizes['size.float-toolbar-height'])
    // Near a pill: the radius is over a third of the height, under half of it.
    expect(BAR_RADIUS).toBeGreaterThan(height / 3)
    expect(BAR_RADIUS).toBeLessThan(height / 2)
    expect(sizes['size.float-button']).toBe('28px')
    expect(height).toBe(38)
  })

  it('is a capsule, its end buttons concentric with its ends', () => {
    expect(rule('.cm-tooltip.cm-float-bar').paddingInline).toBe('var(--size-float-toolbar-end)')
    expect(rule('.cm-float-tip').borderRadius).toBe('var(--radius-glass-tooltip)')
    expect(rule('.cm-float-kbd').borderRadius).toBe('var(--radius-button)')
  })

  it('shows a button icon at its own size, never scaled by the mask', () => {
    expect(JSON.stringify(rule('.cm-float-button .icon'))).not.toMatch(/contain|mask/i)
  })

  it('fades a button tooltip in and out like the app tooltips, above its button with the app gap', () => {
    const tip = rule('.cm-float-tip')
    expect(tip.animation).toBe(
      'cm-fade-in var(--motion-duration-popover) var(--motion-easing-standard)',
    )
    // Unshifted, so the window-aligned gradient in its glass lines up with the bar's.
    expect(tip.transform).toBeUndefined()
    expect(rule('.cm-float-tip[data-side="above"]').bottom).toBe('calc(100% + var(--tooltip-gap))')
    expect(rule('.cm-float-tip[data-side="below"]').top).toBe('calc(100% + var(--tooltip-gap))')
    expect(rule('.cm-float-tip[data-closing][data-closing-motion="fade"]').animation).toBe(
      'cm-fade-out var(--motion-duration-popover) var(--motion-easing-standard) forwards',
    )
  })

  it('lets a bar hold its notch on the anchor when the bar is held back', () => {
    expect(rule('.cm-float-notch').left).toContain('var(--float-notch-x, 25px)')
  })

  it('gives the tooltip bubble a notch toward its button, following the button when the bubble shifts', () => {
    // Outside the bubble's edge toward the button.
    expect(rule('.cm-float-tip[data-side="below"]::before').bottom).toBe('100%')
    expect(rule('.cm-float-tip[data-side="above"]::before').top).toBe('100%')
    const layers = rule('.cm-float-tip::before, .cm-float-tip::after')
    expect(layers.left).toBe('calc(var(--tip-notch, 50%) - 6px)')
    expect([layers.width, layers.height]).toEqual([`${NOTCH_WIDTH}px`, `${NOTCH_HEIGHT}px`])
  })

  it('draws the bubble notch like the bar notch, unturned: the edge as a band, the material half a pixel in', () => {
    expect(JSON.stringify(floatStyles)).not.toContain('rotate')
    const bar = (s: string) => (notchStyles[s as keyof typeof notchStyles] as Rule).clipPath
    expect(rule('.cm-float-tip[data-side="above"]::before').clipPath).toBe(
      bar('.cm-tooltip-above > .cm-float-notch::before'),
    )
    expect(rule('.cm-float-tip[data-side="below"]::before').clipPath).toBe(
      bar('.cm-tooltip-below > .cm-float-notch::before'),
    )
    const down = rule('.cm-float-tip[data-side="above"]::after')
    expect(down.top).toBe(`calc(100% - ${EDGE}px)`)
    expect(down.background).toBe('var(--glass-tint)')
    // Cut at the bubble's edge, so the two translucent fills never overlap.
    expect(down.clipPath).toBe('polygon(0.5px 0.5px, calc(100% - 0.5px) 0.5px, 50% 100%)')
    const up = rule('.cm-float-tip[data-side="below"]::after')
    expect(up.bottom).toBe(`calc(100% - ${EDGE}px)`)
    expect(up.background).toBe('var(--glass-sheen-top), var(--glass-tint)')
    expect(up.clipPath).toBe(
      'polygon(0.5px calc(100% - 0.5px), calc(100% - 0.5px) calc(100% - 0.5px), 50% 0)',
    )
  })

  it('stops the top highlight either side of a notch on the top edge', () => {
    const below = rule('.cm-float-tip[data-side="below"]')
    expect(below.boxShadow).toBe('var(--glass-rim-edge), var(--popover-shadow)')
    expect(below.background).toBe(
      `${highlightBesideNotch('var(--tip-notch, 50%)', `${NOTCH_WIDTH}px`)}, var(--glass-material-bg)`,
    )
    const bar = rule('.cm-tooltip.cm-tooltip-below.cm-float-bar')
    expect(bar.boxShadow).toMatch(/^var\(--glass-rim-edge\), /)
    expect(bar.boxShadow).toContain('var(--color-shadow-float-bar)')
    expect(bar.background).toBe(
      `${highlightBesideNotch('var(--float-notch-x, 25px)', `${NOTCH_WIDTH}px`)}, var(--glass-material-bg)`,
    )
  })

  it('shifts a tooltip in from the editor frame and keeps its notch on the button', () => {
    const room = { left: 0, right: 400 }
    // Clear of both edges: the bubble stays on the button, the notch at its centre.
    expect(placeFloatTip(200, 60, room)).toEqual({ left: 170, notch: 30 })
    // The first button: the bubble's left would be -20, so it moves in to 4px from the frame.
    expect(placeFloatTip(10, 60, room)).toEqual({ left: 4, notch: 8 })
    // The last button, the same from the right. The notch stops 8px short of the corner.
    expect(placeFloatTip(390, 60, room)).toEqual({ left: 336, notch: 52 })
  })
})
