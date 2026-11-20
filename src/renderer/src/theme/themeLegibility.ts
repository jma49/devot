// A plugin theme is never harder to read than Devot's own (ADR 0026): each text color reaches the contrast Devot's
// default theme gives it on the same grounds (capped at WCAG AAA), and each selection and control fill
// stands out from its surface as much as Devot's does. A color that already reaches its floor is left as the theme has
// it; one that does not grows lighter in Dark Mode or darker in Light Mode just far enough, in OKLCH so its hue and
// colorfulness stay and a theme keeps its character.
import {
  composite,
  contrastRatio,
  parseColor,
  readableOn,
  toHex,
  type Rgb,
  type Rgba,
} from './contrast'
import type { Appearance } from './appearance'
import { dark, light } from './tokens'

type Tokens = Readonly<Record<string, string>>

const AA = 4.5
const AAA = 7
/** Colored text (syntax, alerts) stops sooner, so a theme's palette is not washed toward white or black. */
const COLORED = 6

/** Text drawn on the app's surfaces, on a selected row and on the editor's active line. */
const TEXT = [
  'text-primary',
  'text-editor',
  'text-secondary',
  'text-tertiary',
  'text-hover',
  'text-selected',
  'accent-text',
]
const TEXT_GROUPS = ['syntax-', 'alert-']

/** Fills that mark a selection or a control: each stands out from the surfaces it lies on. */
const FILLS = [
  'fill-row-selected',
  'fill-row-selected-unemphasized',
  'fill-row-selected-inactive',
  'fill-segment-on',
  'fill-track',
  'editor-active-line',
]

const SURFACES = ['surface-list', 'surface-editor', 'surface-sidebar-opaque']

const named = (tokens: Tokens): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tokens)
      .filter(([key]) => key.startsWith('color.'))
      .map(([key, value]) => [key.slice('color.'.length).replaceAll('.', '-'), value]),
  )

const BASE: Record<Appearance, Record<string, string>> = { light: named(light), dark: named(dark) }

function read(value: string | undefined): Rgba | undefined {
  if (value === undefined) return undefined
  try {
    return parseColor(value)
  } catch {
    return undefined
  }
}

const isColored = (name: string) => TEXT_GROUPS.some((group) => name.startsWith(group))

const textTokens = (tokens: Record<string, string>) => [
  ...TEXT.filter((name) => name in tokens),
  ...Object.keys(tokens).filter((name) => TEXT_GROUPS.some((group) => name.startsWith(group))),
]

/** The grounds text sits on: the surfaces, a selected row over them, and the editor's active line. */
const solids = (tokens: Record<string, string>, names: readonly string[]): Rgb[] =>
  names.flatMap((name) => {
    const color = read(tokens[name])
    return color ? [color.rgb] : []
  })

function grounds(tokens: Record<string, string>): Rgb[] {
  const surfaces = solids(tokens, SURFACES)
  const row = read(tokens['fill-row-selected-unemphasized'])
  const line = read(tokens['editor-active-line'])
  const editor = read(tokens['surface-editor'])?.rgb
  return [
    ...surfaces,
    ...(row ? surfaces.map((s) => composite(row, s)) : []),
    ...(line && editor ? [composite(line, editor)] : []),
  ]
}

const toLinear = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const fromLinear = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055)

type Lch = [number, number, number]

function toLch([r, g, b]: Rgb): Lch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), Math.atan2(B, A)]
}

/** The sRGB color, or undefined outside the gamut. */
function srgb([L, C, h]: Lch): Rgb | undefined {
  const [A, B] = [C * Math.cos(h), C * Math.sin(h)]
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  if (linear.some((v) => v < -1e-4 || v > 1 + 1e-4)) return undefined
  return linear.map((v) => Math.round(fromLinear(Math.min(1, Math.max(0, v))))) as Rgb
}

/** At lightness `L`, the most colorful in-gamut color of the hue, no more colorful than `C`. */
function atLightness(L: number, C: number, h: number): Rgb {
  let [lo, hi] = [0, C]
  if (srgb([L, C, h])) return srgb([L, C, h])!
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (srgb([L, mid, h])) lo = mid
    else hi = mid
  }
  return srgb([L, lo, h]) ?? (srgb([L, 0, h]) as Rgb)
}

/** `color` made lighter (or darker) in OKLCH just until it reaches `target` on every ground. */
function readableKeepingHue(
  color: Rgb,
  backgrounds: Rgb[],
  direction: 'darker' | 'lighter',
  target: number,
): Rgb {
  const [L, C, h] = toLch(color)
  const reaches = (l: number) => worst(atLightness(l, C, h), backgrounds) >= target
  let [near, far] = direction === 'lighter' ? [L, 1] : [L, 0]
  if (!reaches(far)) return readableOn(color, backgrounds, direction, target)
  for (let i = 0; i < 24; i++) {
    const mid = (near + far) / 2
    if (reaches(mid)) far = mid
    else near = mid
  }
  return atLightness(far, C, h)
}

const worst = (color: Rgb, backgrounds: Rgb[]) =>
  Math.min(...backgrounds.map((b) => contrastRatio(color, b)))

/** How far a fill stands out from the surfaces it lies on. */
function standsOut(fill: Rgba, surfaces: Rgb[]): number {
  return Math.min(...surfaces.map((s) => contrastRatio(composite(fill, s), s)))
}

/** The fill's own color at the least opacity that stands out `floor` from every surface, or opaque. */
function fillFor(fill: Rgba, surfaces: Rgb[], floor: number): Rgba {
  if (standsOut(fill, surfaces) >= floor) return fill
  for (let alpha = Math.ceil(fill.alpha * 100) + 1; alpha <= 100; alpha++) {
    const next = { rgb: fill.rgb, alpha: alpha / 100 }
    if (standsOut(next, surfaces) >= floor) return next
  }
  return { rgb: fill.rgb, alpha: 1 }
}

const surfacesOf = (tokens: Record<string, string>, fill: string) =>
  solids(tokens, fill === 'editor-active-line' ? ['surface-editor'] : SURFACES)

const hex = (color: Rgba) => toHex(color.rgb, color.alpha)

/** The theme's colors with every text and selection color raised to its floor; the colors it changes are added. */
export function legibleColors(colors: Tokens, appearance: Appearance): Record<string, string> {
  const base = BASE[appearance]
  const out: Record<string, string> = { ...colors }
  const merged = () => ({ ...base, ...out })

  for (const name of FILLS) {
    const own = read(merged()[name])
    const devot = read(base[name])
    if (!own || !devot) continue
    const floor = standsOut(devot, surfacesOf(base, name))
    const next = fillFor(own, surfacesOf(merged(), name), floor)
    if (next !== own) out[name] = hex(next)
  }

  const devotGrounds = grounds(base)
  const ownGrounds = grounds(merged())
  if (ownGrounds.length === 0) return out
  const direction = appearance === 'dark' ? 'lighter' : 'darker'
  for (const name of textTokens(merged())) {
    const own = read(merged()[name])
    const devot = read(base[name])
    if (!own) continue
    const cap = isColored(name) ? COLORED : AAA
    const floor = Math.min(cap, devot ? worst(devot.rgb, devotGrounds) : AA)
    if (worst(own.rgb, ownGrounds) >= floor) continue
    out[name] = toHex(readableKeepingHue(own.rgb, ownGrounds, direction, floor), own.alpha)
  }

  return out
}
