import { describe, expect, it } from 'vitest'
import { composite, contrastRatio, parseColor, type Rgb } from './contrast'
import { legibleColors } from './themeLegibility'
import { dark, light } from './tokens'

// A theme from any plugin, official or not, is drawn at least as readably as Devot's own (ADR 0026).

const rgb = (hex: string) => parseColor(hex).rgb
const ratio = (fg: string, bg: string) => contrastRatio(rgb(fg), rgb(bg))
const hueOf = ([r, g, b]: Rgb) => {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}

/** A dim third-party dark theme: olive grounds, muted text, faint selections. */
const MUDDY = {
  'surface-list': '#32302f',
  'surface-editor': '#32302f',
  'surface-sidebar-opaque': '#3c3836',
  'text-primary': '#a89984',
  'text-editor': '#a89984',
  'text-secondary': '#7c6f64',
  'text-tertiary': '#665c54',
  'syntax-heading': '#689d6a',
  'syntax-link': '#7c8f72',
  'accent-text': '#83a598',
  'accent-fill': '#83a598',
  'accent-on-fill': '#a8b8b0',
  'fill-row-selected-unemphasized': '#ebdbb20a',
  'fill-row-selected': '#ebdbb208',
}

describe('legibleColors', () => {
  it("changes nothing in Devot's own theme", () => {
    expect(legibleColors({}, 'dark')).toEqual({})
    expect(legibleColors({}, 'light')).toEqual({})
  })

  it('raises every dim text color to the contrast Devot gives it, at least AA, keeping its hue', () => {
    const out = legibleColors(MUDDY, 'dark')
    const editor = out['surface-editor']!
    expect(editor).toBe('#32302f')
    for (const name of ['text-primary', 'text-secondary', 'text-tertiary', 'syntax-heading']) {
      expect(ratio(out[name]!, editor)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(out[name]!, editor)).toBeGreaterThan(
        ratio(MUDDY[name as 'text-primary'], editor),
      )
    }
    expect(ratio(out['text-primary']!, editor)).toBeGreaterThanOrEqual(7)
    expect(
      Math.abs(hueOf(rgb(out['syntax-heading']!)) - hueOf(rgb(MUDDY['syntax-heading']))),
    ).toBeLessThan(6)
    expect(ratio(out['accent-on-fill']!, out['accent-fill']!)).toBeGreaterThanOrEqual(4.5)
  })

  it("lifts a faint selected row until it stands out as much as Devot's own", () => {
    const out = legibleColors(MUDDY, 'dark')
    const stand = (fill: string, ground: string) =>
      contrastRatio(composite(parseColor(fill), rgb(ground)), rgb(ground))
    const devot = Math.min(
      ...['list', 'editor', 'sidebar-opaque'].map((s) =>
        stand(
          dark['color.fill.row-selected-unemphasized'],
          dark[`color.surface.${s}` as 'color.surface.list'],
        ),
      ),
    )
    expect(stand(out['fill-row-selected-unemphasized']!, '#32302f')).toBeGreaterThanOrEqual(
      devot - 0.01,
    )
    expect(out['fill-row-selected-unemphasized']!.slice(0, 7)).toBe('#ebdbb2')
  })

  it('leaves a theme that already reads well as it is', () => {
    const crisp = {
      'surface-list': '#1e1e2e',
      'surface-editor': '#1e1e2e',
      'surface-sidebar-opaque': '#181825',
      'text-primary': '#f5f5ff',
      'syntax-heading': '#f9e2af',
    }
    const out = legibleColors(crisp, 'dark')
    expect(out['text-primary']).toBe('#f5f5ff')
    expect(out['syntax-heading']).toBe('#f9e2af')
  })

  it('darkens in Light Mode', () => {
    const out = legibleColors({ 'text-secondary': '#b0b0b0' }, 'light')
    expect(ratio(out['text-secondary']!, light['color.surface.editor'])).toBeGreaterThanOrEqual(4.5)
    expect(rgb(out['text-secondary']!)[0]).toBeLessThan(0xb0)
  })
})
