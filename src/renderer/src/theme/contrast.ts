// WCAG contrast maths on sRGB colours: parsing the colour strings the tokens
// and the browser give, measuring a ratio, and moving a colour just far
// enough to reach one. Pure, so both the app and its tests use it.

export type Rgb = [number, number, number]

export interface Rgba {
  rgb: Rgb
  alpha: number
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTIONAL = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[/,]\s*([\d.]+%?))?\s*\)$/i
const FALLBACK = /^var\(\s*--[\w-]+\s*,\s*(.+)\)$/

/** Reads three-, six- and eight-digit hex, the functional rgb notation and a variable's fallback value. */
export function parseColor(css: string): Rgba {
  const text = css.trim()
  const fallback = FALLBACK.exec(text)
  if (fallback) return parseColor(fallback[1]!)
  const hex = HEX.exec(text)
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!
    const byte = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16)
    const alpha = digits.length === 8 ? byte(3) / 255 : 1
    return { rgb: [byte(0), byte(1), byte(2)], alpha }
  }
  const fn = FUNCTIONAL.exec(text)
  if (fn) {
    const a = fn[4]
    const alpha = a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a)
    return { rgb: [Number(fn[1]), Number(fn[2]), Number(fn[3])], alpha }
  }
  throw new Error(`E_COLOR_UNREADABLE ${text}`)
}

/** `fg` drawn over an opaque `background`. */
export function composite(fg: Rgba, background: Rgb): Rgb {
  const mixed = fg.rgb.map((c, i) => c * fg.alpha + background[i]! * (1 - fg.alpha))
  return mixed as Rgb
}

const channel = (value: number) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** The WCAG contrast ratio of two opaque colours, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** Six-digit hex, or eight digits when `alpha` is under 1. */
export function toHex(rgb: Rgb, alpha = 1): string {
  const channels = alpha < 1 ? [...rgb, alpha * 255] : rgb
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/**
 * `color` as it is when it reaches `target` against every background, else
 * the nearest mix with black (`darker`) or white (`lighter`) that does. It
 * moves in 1% steps, so the hue stays and a colour that passes is not touched.
 */
export function readableOn(
  color: Rgb,
  backgrounds: Rgb[],
  direction: 'darker' | 'lighter',
  target: number,
): Rgb {
  const end = direction === 'darker' ? 0 : 255
  for (let step = 0; step <= 100; step++) {
    const t = step / 100
    const candidate = color.map((c) => Math.round(c + (end - c) * t)) as Rgb
    if (backgrounds.every((b) => contrastRatio(candidate, b) >= target)) return candidate
  }
  return [end, end, end]
}
