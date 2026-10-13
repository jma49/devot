import { describe, expect, it } from 'vitest'
import {
  composite,
  contrastRatio,
  parseColor,
  readableOn,
  toHex,
  type Rgb,
  type Rgba,
} from './contrast'
import { dark, light } from './tokens'
import { applyAccent, SELECTION_CONTRAST, type StyleTarget } from './accent'

// WCAG AA, from the token values: text needs 4.5:1, graphics 3:1. The pairs
// below are the ones the UI draws (see app.css, preview/content.css and the
// editor theme), so a later token edit cannot drop one under the line.

type Theme = Record<string, string>
const themes = { light: light as Theme, dark: dark as Theme }
const WHITE: Rgb = [255, 255, 255]

const colour = (theme: Theme, path: string): { rgb: Rgb; alpha: number } => {
  const value = theme[`color.${path}`]
  if (value === undefined) throw new Error(`no token color.${path}`)
  return parseColor(value)
}
const solid = (theme: Theme, path: string): Rgb => colour(theme, path).rgb
const over = (theme: Theme, overlay: string, base: Rgb): Rgb =>
  composite(colour(theme, overlay), base)

const SURFACES = ['surface.list', 'surface.editor', 'surface.sidebar-opaque']

/** What text can sit on: the surfaces, and the translucent fills drawn over them. */
function backdrops(theme: Theme, overlays: string[] = []): Rgb[] {
  const surfaces = SURFACES.map((s) => solid(theme, s))
  return [...surfaces, ...surfaces.flatMap((s) => overlays.map((o) => over(theme, o, s)))]
}

/**
 * What selected editor text sits on, as it is painted: the selection over the
 * editor, and on the active line the line's tint over the selection
 * (CodeMirror draws the selection in a layer under the lines).
 */
function selectionBackdrops(theme: Theme, selection: Rgba): Rgb[] {
  const selected = composite(selection, solid(theme, 'surface.editor'))
  return [selected, over(theme, 'fill.track', selected)]
}

/**
 * The selection against what is around it: the editor on a plain line, the
 * active line's tint on the line with the cursor. Both must reach
 * `SELECTION_CONTRAST` (1.3:1), so a selection reads at a glance.
 */
function selectionStandsOut(theme: Theme, selection: Rgba): Record<string, number> {
  const editor = solid(theme, 'surface.editor')
  const [selected, selectedLine] = selectionBackdrops(theme, selection)
  return {
    'from the editor': contrastRatio(selected!, editor),
    'from the active line': contrastRatio(selectedLine!, over(theme, 'fill.track', editor)),
  }
}

const below = (min: number, ratios: Record<string, number>): string[] =>
  Object.entries(ratios).flatMap(([name, r]) => (r < min ? [`${name} ${r.toFixed(3)}`] : []))

/**
 * The editor's text colours that must keep 4.5:1 on a selection: body, front
 * matter, links and every syntax colour. Only the de-emphasised tertiary text
 * (rules, fences, comments) may drop to 3:1, and only on the selection.
 */
function selectedText(theme: Theme, link: Rgb): Record<string, Rgb> {
  return {
    primary: solid(theme, 'text.primary'),
    'secondary (front matter)': solid(theme, 'text.secondary'),
    link,
    keyword: solid(theme, 'syntax.keyword'),
    function: solid(theme, 'syntax.function'),
    string: solid(theme, 'syntax.string'),
    inserted: solid(theme, 'syntax.inserted'),
    deleted: solid(theme, 'syntax.deleted'),
    heading: solid(theme, 'syntax.heading'),
    markup: solid(theme, 'syntax.markup'),
    list: solid(theme, 'syntax.list'),
  }
}

const checkedOn = (colours: Record<string, Rgb>, backgrounds: Rgb[]) =>
  Object.fromEntries(
    Object.entries(colours).map(([name, fg]) => [name, [fg, backgrounds]]),
  ) as Record<string, [Rgb, Rgb[]]>

const worst = (fg: Rgb, backgrounds: Rgb[]) =>
  Math.min(...backgrounds.map((b) => contrastRatio(fg, b)))

/** The names of the colours whose worst ratio on their backgrounds is under `min`, with it. */
const under = (min: number, checks: Record<string, [Rgb, Rgb[]]>): string[] =>
  Object.entries(checks).flatMap(([name, [fg, backgrounds]]) => {
    const ratio = worst(fg, backgrounds)
    return ratio < min ? [`${name} ${ratio.toFixed(2)}`] : []
  })

describe('colour maths', () => {
  it('measures contrast as WCAG defines it', () => {
    expect(contrastRatio([0, 0, 0], WHITE)).toBeCloseTo(21, 5)
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5)
    expect(contrastRatio([0x77, 0x77, 0x77], WHITE)).toBeCloseTo(4.48, 2)
  })

  it('reads hex, rgb() and a var() fallback', () => {
    expect(parseColor('#0e6b62')).toEqual({ rgb: [14, 107, 98], alpha: 1 })
    expect(parseColor('#0e6b6280')).toEqual({ rgb: [14, 107, 98], alpha: 128 / 255 })
    expect(parseColor('rgb(28 27 25 / 0.1)')).toEqual({ rgb: [28, 27, 25], alpha: 0.1 })
    expect(parseColor('var(--system-accent-fill-light, #0e6b62)').rgb).toEqual([14, 107, 98])
    expect(() => parseColor('red')).toThrow('E_COLOR_UNREADABLE red')
  })

  it('composites a translucent colour over a background', () => {
    expect(composite({ rgb: [0, 0, 0], alpha: 0.5 }, WHITE)).toEqual([127.5, 127.5, 127.5])
    expect(toHex([14, 107, 98])).toBe('#0e6b62')
    expect(toHex([14, 107, 98], 0.5)).toBe('#0e6b6280')
  })

  it('moves a colour no further than the target needs', () => {
    const yellow: Rgb = [255, 198, 0]
    const darker = readableOn(yellow, [WHITE], 'darker', 4.5)
    expect(contrastRatio(darker, WHITE)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(darker, WHITE)).toBeLessThan(4.7)
    // A colour that already passes is returned as it is.
    expect(readableOn([14, 107, 98], [WHITE], 'darker', 4.5)).toEqual([14, 107, 98])
  })
})

describe.each(Object.entries(themes))('the %s theme meets WCAG AA', (_name, theme) => {
  it('draws body text at 4.5:1 on every surface and fill it sits on', () => {
    const plain = backdrops(theme, ['fill.track'])
    const rows = backdrops(theme, ['fill.row-selected-unemphasized'])
    expect(
      under(4.5, {
        primary: [solid(theme, 'text.primary'), plain],
        secondary: [solid(theme, 'text.secondary'), plain],
        tertiary: [solid(theme, 'text.tertiary'), plain],
        'primary on a selected row': [solid(theme, 'text.primary'), rows],
        'secondary on a selected row': [solid(theme, 'text.secondary'), rows],
      }),
    ).toEqual([])
  })

  it('draws accent text and links at 4.5:1', () => {
    const fills = ['fill.track', 'fill.row-selected-unemphasized']
    expect(worst(solid(theme, 'accent.text'), backdrops(theme, fills))).toBeGreaterThanOrEqual(4.5)
  })

  it('puts the on-fill colour on the accent fill at 4.5:1 and keeps the fill visible', () => {
    const fill = solid(theme, 'accent.fill')
    expect(contrastRatio(solid(theme, 'accent.on-fill'), fill)).toBeGreaterThanOrEqual(4.5)
    // The caret and focus rings are graphics.
    expect(worst(fill, backdrops(theme))).toBeGreaterThanOrEqual(3)
  })

  it('draws status text at 4.5:1 and status marks at 3:1', () => {
    const editorAndList = [solid(theme, 'surface.list'), solid(theme, 'surface.editor')]
    const textBackdrops = [
      ...editorAndList,
      ...editorAndList.map((s) => over(theme, 'fill.track', s)),
      ...editorAndList.map((s) => over(theme, 'fill.row-selected-unemphasized', s)),
    ]
    const diff: Record<string, string> = { done: 'diff.added', dropped: 'diff.removed' }
    const text: Record<string, [Rgb, Rgb[]]> = {}
    const marks: Record<string, [Rgb, Rgb[]]> = {}
    for (const id of ['active', 'hold', 'done', 'dropped']) {
      const extra = diff[id] ? editorAndList.map((s) => over(theme, diff[id]!, s)) : []
      text[id] = [solid(theme, `status.${id}`), [...textBackdrops, ...extra]]
      marks[id] = [solid(theme, `status.${id}`), backdrops(theme)]
    }
    expect(under(4.5, text)).toEqual([])
    expect(under(3, marks)).toEqual([])
  })

  it('draws the destructive label at 4.5:1, also on a raised button face', () => {
    const faces = backdrops(theme).flatMap((s) => [
      s,
      over(theme, 'fill.segment-on', s),
      over(theme, 'fill.track', s),
    ])
    expect(worst(solid(theme, 'text.destructive'), faces)).toBeGreaterThanOrEqual(4.5)
  })

  it('draws editor syntax colours at 4.5:1 on the editor, also on the active line', () => {
    const editor = solid(theme, 'surface.editor')
    const lines = [editor, over(theme, 'fill.track', editor)]
    expect(
      under(4.5, {
        keyword: [solid(theme, 'syntax.keyword'), lines],
        function: [solid(theme, 'syntax.function'), lines],
        string: [solid(theme, 'syntax.string'), lines],
        inserted: [solid(theme, 'syntax.inserted'), lines],
        deleted: [solid(theme, 'syntax.deleted'), lines],
        heading: [solid(theme, 'syntax.heading'), lines],
        markup: [solid(theme, 'syntax.markup'), lines],
        list: [solid(theme, 'syntax.list'), lines],
      }),
    ).toEqual([])
  })

  it('sets the selection 1.3:1 apart from the editor and from the active line', () => {
    expect(
      below(SELECTION_CONTRAST, selectionStandsOut(theme, colour(theme, 'accent.selection'))),
    ).toEqual([])
  })

  it('keeps selected editor text readable, also on the active line', () => {
    const backgrounds = selectionBackdrops(theme, colour(theme, 'accent.selection'))
    expect(
      under(4.5, checkedOn(selectedText(theme, solid(theme, 'accent.text')), backgrounds)),
    ).toEqual([])
    // Tertiary text may drop to 3:1 on the selection (only there).
    expect(under(3, { tertiary: [solid(theme, 'text.tertiary'), backgrounds] })).toEqual([])
  })

  it('keeps body text readable on a search match', () => {
    const ink = solid(theme, 'text.primary')
    expect(
      under(4.5, {
        match: [ink, backdrops(theme).map((s) => over(theme, 'fill.match', s))],
        current: [ink, backdrops(theme).map((s) => over(theme, 'fill.match-current', s))],
      }),
    ).toEqual([])
  })
})

// What AppKit reports for the system accents (approximate), light and dark,
// and the extremes any colour could be.
const SYSTEM_ACCENTS: Record<string, [string, string]> = {
  blue: ['#007aff', '#0a84ff'],
  purple: ['#a550a7', '#bf5af2'],
  pink: ['#f74f9e', '#ff375f'],
  red: ['#ff5257', '#ff453a'],
  orange: ['#f7821b', '#ff9f0a'],
  yellow: ['#ffc600', '#ffd60a'],
  green: ['#62ba46', '#32d74b'],
  graphite: ['#989898', '#98989d'],
  white: ['#ffffff', '#ffffff'],
  black: ['#000000', '#000000'],
  'pure yellow': ['#ffff00', '#ffff00'],
}

describe('the system accent', () => {
  function applied(lightHex: string, darkHex: string) {
    const props = new Map<string, string>()
    const style: StyleTarget = {
      setProperty: (name, value) => void props.set(name, value),
      removeProperty: (name) => void props.delete(name),
    }
    applyAccent({ multicolor: false, light: lightHex, dark: darkHex }, style)
    const value = (name: string): Rgba => parseColor(props.get(name) ?? 'missing')
    return Object.assign((name: string): Rgb => value(name).rgb, { value })
  }

  describe.each(Object.entries(SYSTEM_ACCENTS))('%s', (_name, [lightHex, darkHex]) => {
    const read = applied(lightHex, darkHex)

    it.each(['light', 'dark'] as const)(
      'keeps white text on the %s fill at 4.5:1',
      (appearance) => {
        const fill = read(`--system-accent-fill-${appearance}`)
        expect(contrastRatio(WHITE, fill)).toBeGreaterThanOrEqual(4.5)
      },
    )

    it.each([
      ['light', light as Theme],
      ['dark', dark as Theme],
    ] as const)('keeps %s accent text and links at 4.5:1', (appearance, theme) => {
      const fills = ['fill.track', 'fill.row-selected-unemphasized']
      const text = read(`--system-accent-text-${appearance}`)
      expect(worst(text, backdrops(theme, fills))).toBeGreaterThanOrEqual(4.5)
    })
  })

  // The accents macOS offers; the extremes only test the adjustment.
  const EXTREMES = new Set(['white', 'black', 'pure yellow'])
  const OFFERED = Object.entries(SYSTEM_ACCENTS).filter(([name]) => !EXTREMES.has(name))

  describe.each(OFFERED)('%s as the editor selection', (_name, [lightHex, darkHex]) => {
    const read = applied(lightHex, darkHex)

    it.each([
      ['light', light as Theme],
      ['dark', dark as Theme],
    ] as const)(
      'sets the %s selection 1.3:1 apart and keeps its text readable',
      (appearance, theme) => {
        const selection = read.value(`--system-accent-selection-${appearance}`)
        expect(below(SELECTION_CONTRAST, selectionStandsOut(theme, selection))).toEqual([])
        const backgrounds = selectionBackdrops(theme, selection)
        const link = read(`--system-accent-text-${appearance}`)
        expect(under(4.5, checkedOn(selectedText(theme, link), backgrounds))).toEqual([])
        // Tertiary text may drop to 3:1 on the selection (only there).
        expect(under(3, { tertiary: [solid(theme, 'text.tertiary'), backgrounds] })).toEqual([])
      },
    )
  })

  it('leaves a colour that already passes as the system gave it', () => {
    const read = applied(light['color.accent.text'], dark['color.accent.text'])
    expect(toHex(read('--system-accent-fill-light'))).toBe(light['color.accent.text'])
    expect(toHex(read('--system-accent-text-light'))).toBe(light['color.accent.text'])
    expect(toHex(read('--system-accent-text-dark'))).toBe(dark['color.accent.text'])
  })

  it('keeps the hue of a colour it has to darken', () => {
    const read = applied('#ffc600', '#ffd60a')
    const [r, g, b] = read('--system-accent-fill-light')
    expect(r).toBeGreaterThan(b)
    expect(g).toBeGreaterThan(b)
    expect(Math.abs(r / g - 255 / 198)).toBeLessThan(0.05)
  })
})
