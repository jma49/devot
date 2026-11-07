import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flatten, type TokenTree } from '../../scripts/tokens/compile'
import { GRADIENT_THEMES, THEMES } from '../../src/core/editorSettings'
import {
  composite,
  contrastRatio,
  parseColor,
  type Rgb,
} from '../../src/renderer/src/theme/contrast'
import {
  dark,
  ivoryDark,
  ivoryLight,
  light,
  phoneThemes,
} from '../../src/renderer/src/theme/tokens'

type Scheme = 'light' | 'dark'
type Palette = Record<string, string>
const SCHEMES: readonly Scheme[] = ['light', 'dark']
const SLOTS = [
  'glow-start',
  'glow-end',
  'background',
  'card',
  'separator',
  'text-secondary',
  'text-faint',
  'accent',
  'accent-mark',
  'on-accent',
  'glass-tint',
]
const GLOW = ['glow-start', 'glow-end']
const palettes: Record<string, Record<Scheme, Palette>> = {
  default: { light, dark },
  ivory: { light: ivoryLight, dark: ivoryDark },
}
const own = (id: string, scheme: Scheme): Palette =>
  (phoneThemes as Record<string, Record<Scheme, Palette>>)[id]?.[scheme] ?? {}
const palette = (id: string, scheme: Scheme): Palette => (palettes[id] ?? palettes.default!)[scheme]

/** What a theme's screen shows: its slots where it has them, the phone tokens elsewhere. */
function screen(id: string, scheme: Scheme) {
  const slots = own(id, scheme)
  const base = palette(id, scheme)
  const background = parseColor(slots.background ?? base['color.phone.background']!).rgb
  const glow = slots['glow-start'] ? parseColor(slots['glow-start']) : undefined
  return {
    background,
    top: glow ? composite(glow, background) : background,
    text: parseColor(base['color.phone.text']!).rgb,
    secondary: parseColor(slots['text-secondary'] ?? base['color.phone.text-secondary']!).rgb,
    faint: parseColor(slots['text-faint'] ?? base['color.phone.text-faint']!).rgb,
    mark: parseColor(slots['accent-mark'] ?? base['color.accent.text']!).rgb,
    accent: parseColor(slots.accent ?? base['color.accent.fill']!).rgb,
    onAccent: parseColor(slots['on-accent'] ?? base['color.accent.on-fill']!).rgb,
  }
}

const linear = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
/** CIE 1976 ΔE between two sRGB colours, through CIELAB under D65. */
function deltaE(a: Rgb, b: Rgb): number {
  const lab = (rgb: Rgb) => {
    const [r, g, bl] = rgb.map(linear) as Rgb
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
    const x = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047)
    const y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl)
    const z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883)
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
  }
  const [p, q] = [lab(a), lab(b)]
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
}

const backdrops = flatten(
  JSON.parse(readFileSync('design/tokens/backdrops.tokens.json', 'utf8')) as TokenTree,
)
const stops = (id: string, scheme: Scheme) =>
  backdrops.find((t) => t.path === `backdrop.${id}.${scheme}`)!.value as {
    color: { hex: string }
  }[]

describe("the iPhone's theme tokens", () => {
  it.each(GRADIENT_THEMES.flatMap((id) => SCHEMES.map((scheme) => [id, scheme] as const)))(
    'give %s %s every slot',
    (id, scheme) => {
      expect(Object.keys(own(id, scheme)).sort()).toEqual([...SLOTS].sort())
    },
  )

  it('give Ivory its paper glow and nothing else', () => {
    for (const scheme of SCHEMES)
      expect(Object.keys(own('ivory', scheme)).sort()).toEqual([...GLOW].sort())
    expect(own('default', 'light')).toEqual({})
  })

  it.each(GRADIENT_THEMES.flatMap((id) => SCHEMES.map((scheme) => [id, scheme] as const)))(
    "take %s %s's glow hues from its backdrop gradient's ends",
    (id, scheme) => {
      const ends = stops(id, scheme)
      const hex = (slot: string) => {
        const [r, g, b] = parseColor(own(id, scheme)[slot]!).rgb
        return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
      }
      expect(hex('glow-start')).toBe(ends[0]!.color.hex)
      expect(hex('glow-end')).toBe(ends.at(-1)!.color.hex)
    },
  )

  it.each(THEMES.flatMap((id) => SCHEMES.map((scheme) => [id, scheme] as const)))(
    'keep text 4.5:1 on the glow and on the base in %s %s',
    (id, scheme) => {
      const { background, top, text, secondary, mark } = screen(id, scheme)
      for (const surface of [background, top]) {
        expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(secondary, surface)).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrastRatio(mark, background)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(GRADIENT_THEMES.flatMap((id) => SCHEMES.map((scheme) => [id, scheme] as const)))(
    'keep faint text 4.5:1 on the base in %s %s',
    (id, scheme) => {
      const { background, faint } = screen(id, scheme)
      expect(contrastRatio(faint, background)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(THEMES.flatMap((id) => SCHEMES.map((scheme) => [id, scheme] as const)))(
    'keep a label 4.5:1 on an accent fill in %s %s',
    (id, scheme) => {
      const { accent, onAccent } = screen(id, scheme)
      expect(contrastRatio(onAccent, accent)).toBeGreaterThanOrEqual(4.5)
    },
  )

  it.each(SCHEMES)('tell the six themes apart by ΔE 5 at the top of a %s screen', (scheme) => {
    const tops = THEMES.map((id) => [id, screen(id, scheme).top] as const)
    for (const [i, [a, top]] of tops.entries()) {
      for (const [b, other] of tops.slice(i + 1)) {
        expect(deltaE(top, other), `${a} and ${b}`).toBeGreaterThanOrEqual(5)
      }
    }
  })

  it("put a gradient theme's surfaces on the phone tokens, and leave the Mac's alone", () => {
    const css = readFileSync('src/renderer/src/theme/tokens.css', 'utf8')
    const rule = (selector: string) => {
      const start = css.indexOf(`${selector} {`)
      return css.slice(start, css.indexOf('}', start))
    }
    const dawn = rule(":root[data-theme='dawn']")
    expect(dawn).toContain('--color-phone-background: #fcedf3;')
    expect(dawn).toContain('--color-phone-text-secondary: #5f4651;')
    expect(dawn).toContain('--color-phone-glass-opaque: #fdf2f6;')
    expect(dawn).not.toMatch(/--color-(?!phone-)/)
  })
})
