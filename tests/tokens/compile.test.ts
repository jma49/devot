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
    expect(lightBlock).toContain('--color-surface-sidebar: rgb(243 244 246 / 0.7);')
    expect(lightBlock).toContain('--font-size-body: 13px;')
    expect(lightBlock).toContain('--size-sidebar-row: 28px;')
  })

  it('applies an appearance chosen in Settings, or shown by a preview, over the system one', () => {
    const { css } = compile(base, light, dark)
    const [, darkBlock = ''] = css.split('@media (prefers-color-scheme: dark)')
    // The system's dark appearance applies unless Light was chosen.
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
})
