import { describe, expect, it } from 'vitest'
import { parseColor, toHex } from '../theme/contrast'
import { dark, ivoryDark, ivoryLight, light, sizes } from '../theme/tokens'
import {
  besideLine,
  diagramConfig,
  diagramPalette,
  diagramTheme,
  exportPalette,
  labelledTicks,
} from './mermaid-theme'

const hex = (token: string) => {
  const { rgb, alpha } = parseColor(token)
  return toHex(rgb, alpha)
}

describe.each([
  ['light', light],
  ['dark', dark],
  ['ivory light', ivoryLight],
  ['ivory dark', ivoryDark],
] as const)('the diagram theme in %s', (_name, tokens) => {
  const palette = diagramPalette((token) => tokens[token])
  const { themeVariables, themeCSS } = diagramTheme(palette, 'light', sizes['font.family.ui'])

  it('takes the stated tokens', () => {
    expect(palette).toEqual({
      card: tokens['color.fill.card'],
      hairline: tokens['color.line.hairline'],
      edge: tokens['color.text.tertiary'],
      text: tokens['color.text.primary'],
      label: tokens['color.text.secondary'],
      ground: tokens['color.surface.editor'],
      series1: tokens['color.chart.series-1'],
      series2: tokens['color.chart.series-2'],
      series3: tokens['color.chart.series-3'],
      series4: tokens['color.chart.series-4'],
      series5: tokens['color.chart.series-5'],
      series6: tokens['color.chart.series-6'],
      onSeries: tokens['color.chart.on-series'],
      barTask: tokens['color.chart.bar-task'],
      barActive: tokens['color.chart.bar-active'],
      barCrit: tokens['color.chart.bar-crit'],
      onBar: tokens['color.chart.on-bar'],
    })
  })

  it('has no colour that does not come from a token', () => {
    const allowed = new Set(Object.values(palette))
    const allowedVariables = new Set(Object.values(palette).map(hex))
    const colours = Object.entries(themeVariables)
      .filter(([, value]) => typeof value === 'string' && value.startsWith('#'))
      .map(([, value]) => value)
    expect(colours.length).toBeGreaterThan(100)
    for (const colour of colours) expect(allowedVariables).toContain(colour)
    for (const colour of themeCSS.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi) ?? [])
      expect(allowed).toContain(colour)
  })

  it('survives the filter Mermaid applies to theme variables', () => {
    const { fontFamily: _font, darkMode: _dark, ...values } = themeVariables
    for (const colour of Object.values(values)) expect(colour).toMatch(/^[\d "#%(),.;A-Za-z]+$/)
  })
})

describe('the diagram theme', () => {
  const { themeVariables, themeCSS } = diagramTheme(exportPalette, 'dark', 'UI')

  it('sets the stated sizes from their tokens', () => {
    expect(sizes['radius.diagram-node']).toBe('9px')
    expect(sizes['size.diagram-node-edge']).toBe('0.5px')
    expect(sizes['size.diagram-edge']).toBe('1px')
    expect(sizes['font.size.footnote']).toBe('12px')
    expect(sizes['font.size.caption']).toBe('11px')
    expect(themeVariables.fontSize).toBe('12px')
    expect(themeCSS).toContain('rx: 9px')
    expect(themeCSS).toContain('stroke-width: 0.5px')
    expect(themeCSS).toContain('stroke-width: 1px')
    expect(themeCSS).toContain('font-size: 11px')
  })

  it("follows the drawing's appearance", () => {
    expect(themeVariables.darkMode).toBe(true)
  })

  it('draws exports from the light tokens, as their pages are', () => {
    expect(exportPalette.card).toBe(light['color.fill.card'])
  })
})

describe('an edge label beside its line', () => {
  const box = { x: 100, y: 50, width: 40, height: 20 }

  it('goes below a horizontal line', () => {
    const line = [
      { x: 0, y: 50 },
      { x: 200, y: 50 },
    ]
    expect(besideLine(line, box)).toEqual({ dx: 0, dy: 10 + 1 })
  })

  it('goes right of a vertical line', () => {
    const line = [
      { x: 100, y: 0 },
      { x: 100, y: 200 },
    ]
    expect(besideLine(line, box)).toEqual({ dx: 20 + 1, dy: 0 })
  })

  it('reads the segment under the label, not the line as a whole', () => {
    const elbow = [
      { x: 0, y: 200 },
      { x: 0, y: 50 },
      { x: 200, y: 50 },
      { x: 200, y: 200 },
    ]
    expect(besideLine(elbow, box)).toEqual({ dx: 0, dy: 11 })
  })

  it('leaves a label without a line where it is', () => {
    expect(besideLine([], box)).toEqual({ dx: 0, dy: 0 })
  })
})

describe('charts', () => {
  const v = diagramTheme(exportPalette, 'light', 'sans-serif').themeVariables as Record<
    string,
    string | boolean
  >

  it('keep distinct, opaque data colours', () => {
    const pies = [v.pie1, v.pie2, v.pie3, v.pie4, v.pie5, v.pie6]
    expect(new Set(pies).size).toBe(6)
    for (const colour of pies) expect(colour).toMatch(/^#[0-9a-f]{6}$/i)
    expect(v.cScale0).not.toBe(v.cScale1)
    expect(v.git0).not.toBe(v.git1)
    expect(v.taskBkgColor).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('draw a pie without an outer ring or see-through slices', () => {
    expect(v.pieOpacity).toBe('1')
    expect(v.pieOuterStrokeWidth).toBe('0px')
    expect(v.pieStrokeWidth).toBe('0px')
  })

  it('never fall back to a tag colour', () => {
    const tags = Object.entries(light)
      .filter(([key]) => key.startsWith('color.tag.'))
      .map(([, value]) => hex(value))
    for (const colour of Object.values(v)) expect(tags).not.toContain(colour)
  })
})

describe('a gantt chart', () => {
  it('is drawn for the width it is shown in, with short dates', () => {
    expect(diagramConfig(480).gantt).toMatchObject({ useWidth: 480, axisFormat: '%b %-d' })
  })

  it('keeps the width of an exported page when no width is given', () => {
    expect(diagramConfig().gantt.useWidth).toBe(parseFloat(sizes['size.reading-width']))
  })

  it('labels only the ticks that do not collide', () => {
    expect(labelledTicks([0, 20, 40, 60, 80, 100], 30)).toEqual([0, 40, 80])
    expect(labelledTicks([0, 100, 200], 30)).toEqual([0, 100, 200])
    expect(labelledTicks([], 30)).toEqual([])
  })
})
