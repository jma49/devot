import { describe, expect, it } from 'vitest'
import {
  applyAccent,
  ringAlpha,
  ringSurfaces,
  selectionTint,
  selectionTints,
  type StyleTarget,
} from './accent'
import { composite, contrastRatio, parseColor, toHex } from './contrast'
import { dark, light } from './tokens'

const THEMES: Record<'light' | 'dark', Record<string, string>> = { light, dark }

function fakeStyle() {
  const props = new Map<string, string>()
  const style: StyleTarget = {
    setProperty: (name, value) => void props.set(name, value),
    removeProperty: (name) => void props.delete(name),
  }
  return { style, props }
}

describe('system accent', () => {
  it('overrides the fill, the text colour, the selection and the focus ring in both appearances', () => {
    const { style, props } = fakeStyle()
    applyAccent({ multicolor: false, light: '#007aff', dark: '#0a84ff' }, style)
    expect([...props.keys()].sort()).toEqual([
      '--system-accent-fill-dark',
      '--system-accent-fill-light',
      '--system-accent-ring-dark',
      '--system-accent-ring-light',
      '--system-accent-selection-dark',
      '--system-accent-selection-inactive-dark',
      '--system-accent-selection-inactive-light',
      '--system-accent-selection-light',
      '--system-accent-text-dark',
      '--system-accent-text-light',
    ])
    for (const role of ['fill', 'text', 'selection', 'selection-inactive'])
      for (const appearance of ['light', 'dark'])
        expect(props.get(`--system-accent-${role}-${appearance}`)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('draws the selection as a solid tint of the fill', () => {
    const { style, props } = fakeStyle()
    applyAccent({ multicolor: false, light: '#007aff', dark: '#0a84ff' }, style)
    for (const appearance of ['light', 'dark'] as const) {
      const fill = parseColor(props.get(`--system-accent-fill-${appearance}`)!).rgb
      const selection = props.get(`--system-accent-selection-${appearance}`)!
      expect(selection).toMatch(/^#[0-9a-f]{6}$/)
      expect(selection).toBe(toHex(selectionTint(fill, appearance)))
    }
  })

  it('tints the default selection from the caret colour, as the runtime tints a fill', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const theme = THEMES[appearance]
      const caret = parseColor(theme['color.editor.caret']!).rgb
      const { focused, inactive } = selectionTints(caret, appearance)
      expect(theme['color.accent.selection']).toBe(toHex(focused))
      expect(theme['color.accent.selection-inactive']).toBe(toHex(inactive))
    }
  })

  it('draws the focus ring from the fill, as translucent as 3:1 on every surface allows', () => {
    const { style, props } = fakeStyle()
    applyAccent({ multicolor: false, light: '#ffcc00', dark: '#0a84ff' }, style)
    for (const appearance of ['light', 'dark'] as const) {
      const fill = parseColor(props.get(`--system-accent-fill-${appearance}`)!)
      const ring = parseColor(props.get(`--system-accent-ring-${appearance}`)!)
      expect(ring.rgb).toEqual(fill.rgb)
      // Never fainter than the theme's own ring.
      const own = parseColor(THEMES[appearance]['color.focus.ring']!).alpha
      expect(ring.alpha).toBeGreaterThanOrEqual(own - 1 / 255)
      for (const surface of ringSurfaces(appearance))
        expect(contrastRatio(composite(ring, surface), surface)).toBeGreaterThanOrEqual(3)
    }
  })

  it('sets the theme ring to the design strength, raised only as far as 3:1 needs', () => {
    const design = { light: 0.4, dark: 0.3 }
    for (const appearance of ['light', 'dark'] as const) {
      const theme = THEMES[appearance]
      const fill = parseColor(theme['color.accent.fill']!).rgb
      const ring = parseColor(theme['color.focus.ring']!)
      expect(ring.rgb).toEqual(fill)
      expect(ring.alpha).toBeCloseTo(ringAlpha(fill, appearance, design[appearance]), 2)
    }
  })

  it('removes the overrides for Multicolor so the default tokens apply', () => {
    const { style, props } = fakeStyle()
    applyAccent({ multicolor: false, light: '#007aff', dark: '#0a84ff' }, style)
    applyAccent({ multicolor: true, light: null, dark: null }, style)
    expect(props.size).toBe(0)
  })

  it('ignores malformed colours instead of writing them into CSS', () => {
    const { style, props } = fakeStyle()
    applyAccent({ multicolor: false, light: 'red;}', dark: '#0a84ff' }, style)
    expect(props.size).toBe(0)
  })
})
