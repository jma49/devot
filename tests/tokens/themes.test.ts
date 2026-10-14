import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flatten, type TokenTree } from '../../scripts/tokens/compile'
import { BUILT_IN_THEMES } from '../../scripts/tokens/themes'
import { THEMES } from '../../src/core/editorSettings'
import {
  composite,
  contrastRatio,
  parseColor,
  type Rgb,
} from '../../src/renderer/src/theme/contrast'
import { dark, ivoryDark, ivoryLight, light } from '../../src/renderer/src/theme/tokens'

// Every theme provides the same colour tokens as the default one, in a light
// and a dark appearance: a missing or an extra token fails here, not in a
// window that shows a blank. The palette checks pin the design values
// (design/README.md "Themes").

type Appearance = 'light' | 'dark'
const APPEARANCES: Appearance[] = ['light', 'dark']
const FILES = 'design/tokens/themes'

const file = (theme: string, appearance: Appearance) =>
  `${FILES}/${theme}.${appearance}.tokens.json`
const tree = (theme: string, appearance: Appearance) =>
  JSON.parse(readFileSync(file(theme, appearance), 'utf8')) as TokenTree
const tokens = (theme: string, appearance: Appearance) => flatten(tree(theme, appearance))

describe('the built-in themes', () => {
  it('are the theme files on disk, the setting values and the generated ids, in one order', () => {
    const onDisk = [...new Set(readdirSync(FILES).map((name) => name.split('.')[0]!))]
    // The default theme is the system's; the others are built into the stylesheet.
    expect(onDisk.sort()).toEqual(['system', ...BUILT_IN_THEMES.map((t) => t.id)].sort())
    expect(THEMES).toEqual(['default', ...BUILT_IN_THEMES.map((t) => t.id)])
    for (const name of readdirSync(FILES))
      expect(name).toMatch(/^[a-z]+\.(light|dark)\.tokens\.json$/)
  })
})

describe.each(BUILT_IN_THEMES.map((t) => t.id))('the %s theme', (id) => {
  describe.each(APPEARANCES)('%s', (appearance) => {
    const system = tokens('system', appearance)
    const own = tokens(id, appearance)

    it('has every colour token of the system theme, and no other', () => {
      const wanted = system.map((t) => t.path).sort()
      const actual = own.map((t) => t.path).sort()
      expect(actual.filter((p) => !wanted.includes(p))).toEqual([])
      expect(wanted.filter((p) => !actual.includes(p))).toEqual([])
      expect(actual).toHaveLength(new Set(actual).size)
    })

    it('types its tokens like the system theme and gives every one a value', () => {
      const types = new Map(system.map((t) => [t.path, t.type]))
      for (const token of own) {
        expect([token.path, token.type]).toEqual([token.path, types.get(token.path)])
        expect(token.value ? '' : `no value for ${token.path}`).toBe('')
      }
    })

    it('names its theme and appearance', () => {
      const ext = (tree(id, appearance) as { $extensions?: Record<string, unknown> }).$extensions
      expect(ext?.['app.devot']).toEqual({ theme: id, appearance })
    })

    it('keeps its own accent: no token follows the system accent colour', () => {
      expect(own.filter((t) => t.systemAccent).map((t) => t.path)).toEqual([])
    })

    it("takes the default theme's accent tokens, except the ones contrast moved", () => {
      // The dark Ivory editor is lighter than the default's: the fill (with the warm
      // ink on it), the accent text, the selections and the focus ring were moved to
      // keep AA (contrast.test.ts); design/README.md lists them.
      const moved: Record<Appearance, string[]> = {
        light: [],
        dark: [
          'color.accent.fill',
          'color.accent.on-fill',
          'color.accent.text',
          'color.accent.selection',
          'color.accent.selection-inactive',
          'color.focus.ring',
        ],
      }
      const accent = (list: typeof own) =>
        Object.fromEntries(
          list
            .filter(
              (t) =>
                (/^color\.(accent|focus)\./.test(t.path) || t.path === 'color.editor.caret') &&
                !moved[appearance].includes(t.path),
            )
            .map((t) => [t.path, t.value]),
        )
      expect(accent(own)).toEqual(accent(system))
      expect(Object.keys(accent(own))).toContain('color.editor.caret')
      for (const path of moved[appearance]) expect(own.some((t) => t.path === path)).toBe(true)
    })
  })
})

describe('the generated stylesheet', () => {
  it('has rules for every built-in theme, scoped by data-theme', () => {
    const css = readFileSync('src/renderer/src/theme/tokens.css', 'utf8')
    for (const { id } of BUILT_IN_THEMES) {
      expect(css).toContain(`:root[data-theme='${id}'] {`)
      expect(css).toContain(`:root[data-theme='${id}']:not([data-appearance='light']) {`)
    }
  })
})

describe('the generated constants', () => {
  it('have the same colour names in every theme and appearance', () => {
    const names = Object.keys(light).sort()
    for (const theme of [dark, ivoryLight, ivoryDark])
      expect(Object.keys(theme).sort()).toEqual(names)
  })
})

describe('Ivory', () => {
  const themes = {
    light: ivoryLight as Record<string, string>,
    dark: ivoryDark as Record<string, string>,
  }
  const rgb = (appearance: Appearance, path: string) => parseColor(themes[appearance][path]!)
  const hex = (appearance: Appearance, path: string) => themes[appearance][path]

  it('draws the light surfaces from the sidebar, darkest, to the editor, lightest', () => {
    expect(hex('light', 'color.surface.sidebar-opaque')).toBe('#f5f4ed')
    expect(rgb('light', 'color.surface.sidebar').rgb).toEqual(
      rgb('light', 'color.surface.sidebar-opaque').rgb,
    )
    // The sidebar keeps the default theme's translucency, for the window material.
    expect(rgb('light', 'color.surface.sidebar').alpha).toBe(
      parseColor(light['color.surface.sidebar']!).alpha,
    )
    expect(hex('light', 'color.surface.list')).toBe('#faf9f5')
    expect(hex('light', 'color.surface.editor')).toBe('#ffffff')
    expect(hex('light', 'color.surface.popover')).toBe('#ffffff')
  })

  it('draws the dark surfaces from the sidebar, darkest, to the editor, lightest', () => {
    expect(hex('dark', 'color.surface.sidebar-opaque')).toBe('#1f1e1d')
    expect(rgb('dark', 'color.surface.sidebar').rgb).toEqual(
      rgb('dark', 'color.surface.sidebar-opaque').rgb,
    )
    expect(rgb('dark', 'color.surface.sidebar').alpha).toBe(
      parseColor(dark['color.surface.sidebar']!).alpha,
    )
    expect(hex('dark', 'color.surface.list')).toBe('#262624')
    expect(hex('dark', 'color.surface.editor')).toBe('#30302e')
    // The popover is the editor's colour or one step above it, never below.
    const lum = (appearance: Appearance, path: string) =>
      contrastRatio(rgb(appearance, path).rgb, [0, 0, 0])
    expect(lum('dark', 'color.surface.popover')).toBeGreaterThanOrEqual(
      lum('dark', 'color.surface.editor'),
    )
  })

  it('steps the surfaces: sidebar, note list, editor', () => {
    const black: Rgb = [0, 0, 0]
    const level = (appearance: Appearance, name: string) =>
      contrastRatio(rgb(appearance, `color.surface.${name}`).rgb, black)
    expect(level('light', 'sidebar-opaque')).toBeLessThan(level('light', 'list'))
    expect(level('light', 'list')).toBeLessThan(level('light', 'editor'))
    expect(level('dark', 'sidebar-opaque')).toBeLessThan(level('dark', 'list'))
    expect(level('dark', 'list')).toBeLessThan(level('dark', 'editor'))
  })

  it('writes warm text: primary, secondary and tertiary, no cooler than the design values', () => {
    expect(hex('light', 'color.text.primary')).toBe('#141413')
    expect(hex('light', 'color.text.secondary')).toBe('#3d3d3a')
    expect(hex('dark', 'color.text.primary')).toBe('#faf9f5')
    expect(hex('dark', 'color.text.secondary')).toBe('#c2c0b6')
    // Tertiary is the design value, or the nearest value that passes (README says which).
    const close = (appearance: Appearance, design: string) => {
      const a = rgb(appearance, 'color.text.tertiary').rgb
      const b = parseColor(design).rgb
      return a.every((c, i) => Math.abs(c - b[i]!) <= 40)
    }
    expect(close('light', '#73726c')).toBe(true)
    expect(close('dark', '#9c9a92')).toBe(true)
  })

  it('draws placeholder and disabled text at half the primary text, over the editor', () => {
    for (const appearance of APPEARANCES) {
      const editor = rgb(appearance, 'color.surface.editor').rgb
      const half = composite({ rgb: rgb(appearance, 'color.text.primary').rgb, alpha: 0.5 }, editor)
      for (const path of ['color.text.placeholder', 'color.text.disabled']) {
        const token = rgb(appearance, path).rgb
        expect(token.map((c, i) => Math.abs(c - half[i]!) <= 1)).toEqual([true, true, true])
      }
    }
  })

  it('draws lines from one warm ink: borders at 15% (light) or 10% (dark), controls at 30%', () => {
    expect(rgb('light', 'color.ink.line').rgb).toEqual(parseColor('#1f1e1d').rgb)
    expect(rgb('dark', 'color.ink.line').rgb).toEqual(parseColor('#faf9f5').rgb)
    for (const [appearance, alpha] of [
      ['light', 0.15],
      ['dark', 0.1],
    ] as const) {
      for (const path of ['color.line.hairline', 'color.line.separator']) {
        expect(rgb(appearance, path).rgb).toEqual(rgb(appearance, 'color.ink.line').rgb)
        expect(rgb(appearance, path).alpha).toBeCloseTo(alpha, 3)
      }
      expect(rgb(appearance, 'color.line.control').rgb).toEqual(
        rgb(appearance, 'color.ink.line').rgb,
      )
      expect(rgb(appearance, 'color.line.control').alpha).toBeCloseTo(0.3, 3)
    }
  })

  it("casts the pop-up shadow from the warm ink, at the default theme's strengths", () => {
    for (const [appearance, base] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const path of [
        'color.shadow.popover-key',
        'color.shadow.popover-ambient',
        'color.line.shadow',
      ]) {
        expect(rgb(appearance, path).rgb).toEqual(parseColor('#1f1e1d').rgb)
        expect(rgb(appearance, path).alpha).toBeCloseTo(
          parseColor((base as Record<string, string>)[path]!).alpha,
          3,
        )
      }
    }
  })

  it("selects a row with the default theme's recipe: a wash of the same strength", () => {
    for (const [appearance, base] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      expect(rgb(appearance, 'color.fill.row-selected-unemphasized')).toEqual(
        parseColor(base['color.fill.row-selected-unemphasized']!),
      )
      expect(rgb(appearance, 'color.fill.row-selected').alpha).toBeCloseTo(
        parseColor(base['color.fill.row-selected']!).alpha,
        3,
      )
    }
  })

  it('maps the status tints: info, danger, success and warning', () => {
    // Design values; contrast.test.ts holds what each must reach. A tint that
    // had to move records how far in its `$description` (design/README.md).
    const near = (appearance: Appearance, path: string, design: string, slack: number) => {
      const a = rgb(appearance, path).rgb
      const b = parseColor(design).rgb
      return a.every((c, i) => Math.abs(c - b[i]!) <= slack)
    }
    expect(near('light', 'color.alert.note', '#3266ad', 40)).toBe(true)
    expect(near('light', 'color.alert.caution', '#7f2c28', 40)).toBe(true)
    expect(near('light', 'color.alert.tip', '#265b19', 40)).toBe(true)
    expect(near('light', 'color.alert.warning', '#5a4815', 40)).toBe(true)
    expect(near('dark', 'color.alert.note', '#80aadd', 40)).toBe(true)
    expect(near('dark', 'color.alert.caution', '#ee8884', 40)).toBe(true)
    expect(near('dark', 'color.alert.tip', '#7ab948', 40)).toBe(true)
    expect(near('dark', 'color.alert.warning', '#d1a041', 40)).toBe(true)
  })

  it('colours the eight tags, each in its own hue', () => {
    const tags = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray']
    for (const appearance of APPEARANCES) {
      const colours = tags.map((id) => hex(appearance, `color.tag.${id}`))
      expect(new Set(colours).size).toBe(8)
    }
  })
})
