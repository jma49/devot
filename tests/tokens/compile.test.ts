import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  compile,
  cssValue,
  cssVarName,
  flatten,
  resolve,
  type TokenTree,
} from '../../scripts/tokens/compile'

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as TokenTree
const base = read('design/tokens/base.tokens.json')
const light = read('design/tokens/themes/system.light.tokens.json')
const dark = read('design/tokens/themes/system.dark.tokens.json')
const ivory = {
  id: 'ivory',
  light: read('design/tokens/themes/ivory.light.tokens.json'),
  dark: read('design/tokens/themes/ivory.dark.tokens.json'),
}

const color = (hex: string, alpha?: number) => ({
  colorSpace: 'srgb',
  components: [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ],
  hex,
  ...(alpha === undefined ? {} : { alpha }),
})

describe('token compiler', () => {
  it('flattens groups and inherits $type', () => {
    const flat = flatten({
      space: { $type: 'dimension', '4': { $value: { value: 8, unit: 'px' } } },
    })
    expect(flat).toEqual([
      { path: 'space.4', type: 'dimension', value: { value: 8, unit: 'px' }, systemAccent: false },
    ])
  })

  it('resolves references, including chains', () => {
    const baseFlat = flatten({
      a: { $type: 'color', $value: color('#112233') },
      b: { $type: 'color', $value: '{a}' },
    })
    const [theme] = resolve(flatten({ c: { $type: 'color', $value: '{b}' } }), baseFlat)
    expect(cssValue(theme!)).toBe('#112233')
  })

  it('rejects missing and circular references', () => {
    expect(() => resolve(flatten({ x: { $type: 'color', $value: '{nope}' } }), [])).toThrow(
      'E_TOKEN_REFERENCE_MISSING',
    )
    const loop = flatten({
      a: { $type: 'color', $value: '{b}' },
      b: { $type: 'color', $value: '{a}' },
    })
    expect(() => resolve(loop, loop)).toThrow('E_TOKEN_REFERENCE_CYCLE')
  })

  it('formats colours, dimensions, font families and weights', () => {
    const f = (type: string, value: unknown) =>
      cssValue({ path: 'x', type, value, systemAccent: false })
    expect(f('color', color('#f1f0ed'))).toBe('#f1f0ed')
    expect(f('color', color('#1c1b19', 0.1))).toBe('rgb(28 27 25 / 0.1)')
    expect(f('dimension', { value: 13, unit: 'px' })).toBe('13px')
    expect(f('fontFamily', ['-apple-system', 'SF Pro Text', 'sans-serif'])).toBe(
      "-apple-system, 'SF Pro Text', sans-serif",
    )
    expect(f('fontWeight', 600)).toBe('600')
    expect(() => f('shadow', {})).toThrow('E_TOKEN_TYPE_UNSUPPORTED')
  })

  it('formats motion: durations, easing curves and plain numbers', () => {
    const f = (type: string, value: unknown) =>
      cssValue({ path: 'x', type, value, systemAccent: false })
    expect(f('duration', { value: 400, unit: 'ms' })).toBe('400ms')
    expect(f('cubicBezier', [0.215, 0.61, 0.355, 1])).toBe('cubic-bezier(0.215, 0.61, 0.355, 1)')
    expect(f('number', 0.8)).toBe('0.8')
  })

  it('names CSS variables after the token path', () => {
    expect(cssVarName('color.surface.sidebar')).toBe('--color-surface-sidebar')
  })

  it('maps the real design tokens for both appearances', () => {
    const { css } = compile(base, light, dark)
    const [lightBlock, darkBlock] = css.split('@media (prefers-color-scheme: dark)')
    expect(lightBlock).toContain('--color-surface-list: #fafaf9;')
    expect(darkBlock).toContain('--color-surface-list: #111111;')
    expect(lightBlock).toContain('--color-surface-sidebar: rgb(255 255 255 / 0.02);')
    expect(darkBlock).toContain('--color-surface-sidebar: rgb(0 0 0 / 0.1);')
    expect(lightBlock).toContain('--color-surface-list-wash: rgb(245 245 244 / 0.8);')
    expect(darkBlock).toContain('--color-surface-list-wash: rgb(23 23 23 / 0.5);')
    expect(lightBlock).toContain('--color-surface-editor-wash: rgb(255 255 255 / 0.7);')
    expect(darkBlock).toContain('--color-surface-editor-wash: rgb(10 10 10 / 0.6);')
    expect(lightBlock).toContain('--color-surface-window: #ffffff;')
    expect(darkBlock).toContain('--color-surface-window: #000000;')
    expect(darkBlock).toContain('--color-surface-popover: #171717;')
    expect(lightBlock).toContain('--font-size-body: 13px;')
    expect(lightBlock).toContain('--size-sidebar-row: 30px;')
    expect(lightBlock).toContain('--size-dialog-row: 28px;')
  })

  it('applies an appearance chosen in Settings, or shown by a preview, over the system one', () => {
    const { css } = compile(base, light, dark)
    const [, darkBlock = ''] = css.split('@media (prefers-color-scheme: dark)')
    expect(darkBlock).toContain(":root:not([data-appearance='light']) {")
    const chosen = (appearance: string) => {
      const start = css.indexOf(
        `:root[data-appearance='${appearance}'], [data-appearance-preview='${appearance}'] {`,
      )
      expect(start).toBeGreaterThan(-1)
      return css.slice(start, css.indexOf('}', start))
    }
    expect(chosen('dark')).toContain('color-scheme: dark;')
    expect(chosen('dark')).toContain('--color-surface-editor: #0a0a0a;')
    expect(chosen('light')).toContain('color-scheme: light;')
    expect(chosen('light')).toContain('--color-surface-editor: #ffffff;')
  })

  it('lets the system accent override the default accent per appearance', () => {
    const { css } = compile(base, light, dark)
    const [lightBlock, darkBlock] = css.split('@media (prefers-color-scheme: dark)')
    expect(lightBlock).toContain('--color-accent-fill: var(--system-accent-fill-light, #3472d6);')
    expect(darkBlock).toContain('--color-accent-fill: var(--system-accent-fill-dark, #4576b2);')
    expect(lightBlock).toContain('--color-accent-text: var(--system-accent-text-light, #2856a2);')
    expect(darkBlock).toContain('--color-accent-text: var(--system-accent-text-dark, #7ea6d8);')
    expect(lightBlock).toContain(
      '--color-accent-selection: var(--system-accent-selection-light, #e3d6fb);',
    )
    expect(darkBlock).toContain(
      '--color-accent-selection: var(--system-accent-selection-dark, #29233a);',
    )
    expect(lightBlock).toContain('--color-accent-on-fill: #ffffff;')
  })

  it('exports theme colours and sizes, never primitive colours', () => {
    const { css, ts } = compile(base, light, dark)
    expect(css).not.toContain('--color-paper-')
    expect(css).not.toContain('--color-teal-')
    expect(ts).toContain('"color.surface.editor": "#ffffff"')
    expect(ts).toContain('"size.toolbar-height": "52px"')
  })

  it('refuses themes whose colour sets differ', () => {
    const partial = { color: { text: { primary: { $type: 'color', $value: color('#000000') } } } }
    expect(() => compile(base, light, partial)).toThrow('E_TOKEN_THEMES_DIFFER')
  })

  describe('built-in themes', () => {
    const { css, ts } = compile(base, light, dark, [ivory])

    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      expect(start > -1 ? '' : `missing rule ${selector}`).toBe('')
      const ends = ['\n}', '\n  }'].map((end) => css.indexOf(end, start)).filter((i) => i > -1)
      return css.slice(start, Math.min(...ends))
    }

    it('leaves the default theme as it is, with or without other themes', () => {
      const plain = compile(base, light, dark)
      expect(plain.css).not.toContain('data-theme')
      expect(css.startsWith(plain.css.trimEnd())).toBe(true)
      expect(ts.startsWith(plain.ts.split('export type ThemeColor')[0]!.trimEnd())).toBe(true)
    })

    it('scopes a theme to the root attribute: light, then dark where dark applies', () => {
      expect(rule(":root[data-theme='ivory']")).toContain('--color-surface-editor: #ffffff;')
      expect(rule(":root[data-theme='ivory']")).not.toContain('--font-size-body')
      const media = css.slice(css.lastIndexOf('@media (prefers-color-scheme: dark)'))
      expect(media).toContain(":root[data-theme='ivory']:not([data-appearance='light']) {")
      expect(media).toContain('--color-surface-editor: #30302e;')
      expect(
        rule(
          ":root[data-theme='ivory'][data-appearance='dark'], [data-theme-preview='ivory'][data-appearance-preview='dark']",
        ),
      ).toContain('--color-surface-editor: #30302e;')
      expect(
        rule(
          ":root[data-theme='ivory'][data-appearance='light'], [data-theme-preview='ivory'][data-appearance-preview='light']",
        ),
      ).toContain('--color-surface-editor: #ffffff;')
    })

    it('shows a theme in a preview card, in the appearance the card names', () => {
      // `data-theme-preview` shows that theme whatever the page's theme; without it the default theme's rules apply.
      expect(css).toContain("[data-theme-preview='ivory'][data-appearance-preview='dark']")
      expect(css).not.toContain(":root[data-theme='ivory'] [data-appearance-preview")
    })

    it('comes after the default theme, and is heavier wherever a default rule could win', () => {
      const lastDefault = css.indexOf(
        ":root[data-appearance='light'], [data-appearance-preview='light'] {",
      )
      expect(css.indexOf(":root[data-theme='ivory'] {")).toBeGreaterThan(lastDefault)
      // More specific than a default rule's one attribute.
      expect(css).toContain(":root[data-theme='ivory'][data-appearance='dark']")
    })

    it('does not follow the system accent', () => {
      const themed = css.slice(css.indexOf(":root[data-theme='ivory'] {"))
      expect(themed).not.toContain('--system-accent')
      expect(themed).toContain('--color-accent-fill: #3472d6;')
    })

    it("exports a theme's colours next to the default ones", () => {
      expect(ts).toContain('export const ivoryLight = {')
      expect(ts).toContain('export const ivoryDark = {')
      expect(ts).toContain('"color.surface.editor": "#30302e"')
    })

    it('refuses a theme whose colours differ from the default theme', () => {
      const partial = { color: { text: { primary: { $type: 'color', $value: color('#000000') } } } }
      expect(() =>
        compile(base, light, dark, [{ id: 'other', light: partial, dark: partial }]),
      ).toThrow('E_TOKEN_THEMES_DIFFER')
    })

    it('refuses a theme id that is not a plain word', () => {
      expect(() => compile(base, light, dark, [{ ...ivory, id: "a'] {" }])).toThrow(
        'E_TOKEN_THEME_ID',
      )
    })
  })
})
