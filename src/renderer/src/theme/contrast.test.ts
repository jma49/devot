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
import { dark, ivoryDark, ivoryLight, light } from './tokens'
import { applyAccent, SELECTION_CONTRAST, type StyleTarget } from './accent'

// WCAG AA, from the token values: text needs 4.5:1, graphics 3:1. The pairs
// below are the ones the UI draws (see app.css, preview/content.css and the
// editor theme), so a later token edit cannot drop one under the line. Every
// built-in theme is held to the same pairs, in both appearances.

type Theme = Record<string, string>
const themes = {
  light: light as Theme,
  dark: dark as Theme,
  'ivory light': ivoryLight as Theme,
  'ivory dark': ivoryDark as Theme,
}
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
  return [selected, over(theme, 'editor.active-line', selected)]
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
    'from the active line': contrastRatio(selectedLine!, over(theme, 'editor.active-line', editor)),
  }
}

const below = (min: number, ratios: Record<string, number>): string[] =>
  Object.entries(ratios).flatMap(([name, r]) => (r < min ? [`${name} ${r.toFixed(3)}`] : []))

function editorText(theme: Theme): Record<string, Rgb> {
  const group = (prefix: string) =>
    Object.keys(theme)
      .filter((key) => key.startsWith(`color.${prefix}.`))
      .map((key) => key.slice('color.'.length))
  return Object.fromEntries(
    ['text.editor', 'text.secondary', ...group('syntax'), ...group('alert')].map((path) => [
      path,
      solid(theme, path),
    ]),
  )
}

/**
 * The editor's text colours that must keep 4.5:1 on a selection: body, front
 * matter, links and every syntax colour. Only the de-emphasised tertiary text
 * (rules, section labels) may drop to 3:1, and only on the selection.
 */
function selectedText(theme: Theme, link: Rgb): Record<string, Rgb> {
  return { primary: solid(theme, 'text.primary'), link, ...editorText(theme) }
}

const checkedOn = (colours: Record<string, Rgb>, backgrounds: Rgb[]) =>
  Object.fromEntries(
    Object.entries(colours).map(([name, fg]) => [name, [fg, backgrounds]]),
  ) as Record<string, [Rgb, Rgb[]]>

const worst = (fg: Rgb, backgrounds: Rgb[]) =>
  Math.min(...backgrounds.map((b) => contrastRatio(fg, b)))

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
        hover: [solid(theme, 'text.hover'), [...plain, ...rows]],
        selected: [solid(theme, 'text.selected'), [...plain, ...rows]],
      }),
    ).toEqual([])
  })

  it('draws a tag chip label at 4.5:1 on its chip, at rest and under the pointer', () => {
    // A chip is its tag colour at 10% (20% under the pointer) over a surface
    // or a selected row (opacity.tag.* tokens).
    const beneath = backdrops(theme, ['fill.row-selected-unemphasized'])
    const chips: Record<string, [Rgb, Rgb[]]> = {}
    for (const key of Object.keys(theme).filter((k) => k.startsWith('color.tag-text.'))) {
      const hue = key.slice('color.tag-text.'.length)
      const tag = solid(theme, `tag.${hue}`)
      const fills = [0.1, 0.2].flatMap((alpha) =>
        beneath.map((b) => composite({ rgb: tag, alpha }, b)),
      )
      chips[hue] = [solid(theme, `tag-text.${hue}`), fills]
    }
    expect(Object.keys(chips)).toHaveLength(8)
    expect(under(4.5, chips)).toEqual([])
  })

  it('draws notebook icons in every tag colour at 3:1 on the sidebar, lists, editor and popovers', () => {
    const beneath = [...backdrops(theme), solid(theme, 'surface.popover')]
    const icons: Record<string, [Rgb, Rgb[]]> = {}
    for (const key of Object.keys(theme).filter((k) => k.startsWith('color.tag-icon.'))) {
      icons[key.slice('color.tag-icon.'.length)] = [
        solid(theme, key.slice('color.'.length)),
        beneath,
      ]
    }
    expect(Object.keys(icons)).toHaveLength(8)
    expect(under(3, icons)).toEqual([])
  })

  it('draws popup text at 4.5:1 on the popover and its selected row', () => {
    // The slash menu, completion popups and the floating toolbar: labels are
    // primary, group headers secondary, key hints tertiary. On the selected
    // row the hint turns secondary (editor/completions.ts).
    const popover = [solid(theme, 'surface.popover'), solid(theme, 'surface.float-bar')]
    const selected = [solid(theme, 'fill.completion-selected')]
    expect(
      under(4.5, {
        primary: [solid(theme, 'text.primary'), popover],
        secondary: [solid(theme, 'text.secondary'), popover],
        tertiary: [solid(theme, 'text.tertiary'), popover],
        'primary on the selected row': [solid(theme, 'text.primary'), selected],
        'hint on the selected row': [solid(theme, 'text.secondary'), selected],
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

  it('draws preview text at 4.5:1 on its blocks: alert titles, marks, tables, the info card', () => {
    const editor = solid(theme, 'surface.editor')
    const alerts = ['note', 'tip', 'important', 'warning', 'caution']
    const pairs: Record<string, [Rgb, Rgb[]]> = Object.fromEntries(
      alerts.map((kind) => [`${kind} alert`, [solid(theme, `alert.${kind}`), [editor]]]),
    )
    const blocks = ['mark.bg', 'table.head', 'table.stripe', 'code-block.bg', 'fill.card']
    pairs['primary on preview blocks'] = [
      solid(theme, 'text.primary'),
      blocks.map((b) => over(theme, b, editor)),
    ]
    pairs['secondary on the info card and code headers'] = [
      solid(theme, 'text.secondary'),
      ['fill.card', 'code-header.bg'].map((b) => over(theme, b, editor)),
    ]
    expect(under(4.5, pairs)).toEqual([])
  })

  it('draws the destructive label at 4.5:1, also on a raised button face', () => {
    const faces = backdrops(theme).flatMap((s) => [
      s,
      over(theme, 'fill.segment-on', s),
      over(theme, 'fill.track', s),
    ])
    expect(worst(solid(theme, 'text.destructive'), faces)).toBeGreaterThanOrEqual(4.5)
  })

  it('draws editor text, secondary text and every syntax and alert colour at 4.5:1 on the editor, also on the active line', () => {
    const editor = solid(theme, 'surface.editor')
    const lines = [editor, over(theme, 'editor.active-line', editor)]
    const colours = editorText(theme)
    expect(Object.keys(colours)).toEqual(
      expect.arrayContaining(['text.editor', 'syntax.heading', 'syntax.link', 'alert.note']),
    )
    expect(under(4.5, checkedOn(colours, lines))).toEqual([])
  })

  it('draws the inactive selection lighter than the focused one, and its text at 4.5:1', () => {
    const editor = solid(theme, 'surface.editor')
    const focused = solid(theme, 'accent.selection')
    const inactive = solid(theme, 'accent.selection-inactive')
    expect(contrastRatio(inactive, editor)).toBeLessThan(contrastRatio(focused, editor))
    expect(contrastRatio(inactive, editor)).toBeGreaterThan(1)
    expect(under(4.5, checkedOn(editorText(theme), [inactive]))).toEqual([])
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
