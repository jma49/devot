import { describe, expect, it } from 'vitest'
import { floatStyles } from './floating'

type Rule = Record<string, string>
const rule = (selector: string) => floatStyles[selector] as Rule

describe('floating bar motion and states', () => {
  it('shows hover and pressed the same way: an outline ring over a fill', () => {
    const hover = rule('.cm-float-button:hover')
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

  it('is one element: surface, a 1 px ring and two soft box shadow layers, no filter and no animation', () => {
    const bar = rule('.cm-tooltip.cm-float-bar')
    expect(bar.outline).toBeUndefined()
    expect(bar.boxShadow).toMatch(/^0 0 0 1px var\(--color-line-hairline\), /)
    expect(bar.border).toBe('0')
    expect(bar.backgroundColor).toBe('var(--color-surface-popover)')
    expect(bar.boxShadow!.split('), ')).toHaveLength(3)
    expect(bar.boxShadow).toContain('var(--color-shadow-popover-key)')
    expect(bar.filter).toBeUndefined()
    expect(bar.animation).toBeUndefined()
    expect(floatStyles['@keyframes cm-fade-in']).toEqual({
      from: { opacity: '0' },
    })
  })

  it('has zero-width separators with a left border and buttons with no gap', () => {
    const separator = rule('.cm-float-separator')
    expect(separator.width).toBe('0')
    expect(separator.borderLeft).toBe('1px solid var(--color-line-separator)')
    expect(rule('.cm-float-buttons').gap).toBeUndefined()
  })

  it('shows a button icon at its own size, never scaled by the mask', () => {
    expect(JSON.stringify(rule('.cm-float-button .icon'))).not.toMatch(/contain|mask/i)
  })

  it('fades a button tooltip in and out like the app tooltips, above its button with the app gap', () => {
    const tip = rule('.cm-float-tip')
    expect(tip.animation).toBe(
      'cm-fade-in var(--motion-duration-popover) var(--motion-easing-standard)',
    )
    expect(tip.transform).toBe('translateX(-50%)')
    expect(rule('.cm-float-tip[data-side="above"]').bottom).toBe('calc(100% + var(--tooltip-gap))')
    expect(rule('.cm-float-tip[data-side="below"]').top).toBe('calc(100% + var(--tooltip-gap))')
    expect(rule('.cm-float-tip[data-closing][data-closing-motion="fade"]').animation).toBe(
      'cm-fade-out var(--motion-duration-popover) var(--motion-easing-standard) forwards',
    )
  })

  it('lets a bar hold its notch on the anchor when the bar is held back', () => {
    expect(rule('.cm-float-notch').left).toContain('var(--float-notch-x, 18px)')
  })

  it('gives the tooltip bubble a notch toward its button', () => {
    expect(rule('.cm-float-tip[data-side="below"]::before').top).toBeDefined()
    expect(rule('.cm-float-tip[data-side="above"]::before').bottom).toBeDefined()
  })
})
