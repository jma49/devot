import { describe, expect, it } from 'vitest'
import { applyAccent, selectionTint, selectionTints, type StyleTarget } from './accent'
import { parseColor, toHex } from './contrast'
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
  it('overrides the fill, the text colour and the selection in both appearances', () => {
    const { style, props } = fakeStyle()
    applyAccent({ multicolor: false, light: '#007aff', dark: '#0a84ff' }, style)
    expect([...props.keys()].sort()).toEqual([
      '--system-accent-fill-dark',
      '--system-accent-fill-light',
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
