import { describe, expect, it } from 'vitest'
import { assetResponse, ASSETS } from '../../licence/src/assets'
import { COLORS, type ColorToken } from '../../licence/src/brand'
import { licenceMail } from '../../licence/src/mail'

type Rgb = [number, number, number]
type Rgba = [number, number, number, number]

function parse(css: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(css)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  const m = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(css)
  if (!m) throw new Error(`unparsed colour ${css}`)
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? Number(m[4]) : 1]
}

const rgbOf = (c: Rgba): Rgb => [c[0], c[1], c[2]]

function over(top: Rgba, below: Rgb): Rgb {
  const a = top[3]
  return [0, 1, 2].map((i) => top[i]! * a + below[i]! * (1 - a)) as Rgb
}

const toLin = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const fromLin = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
}

function ratio(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function toOklab([r, g, b]: Rgb): Rgb {
  const [lr, lg, lb] = [toLin(r), toLin(g), toLin(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(fromLin) as Rgb
}

function mixOklab(a: Rgb, aShare: number, b: Rgb): Rgb {
  const [x, y] = [toOklab(a), toOklab(b)]
  return fromOklab([0, 1, 2].map((i) => x[i]! * aShare + y[i]! * (1 - aShare)) as Rgb)
}

const MIN = 4.5

describe.each(['light', 'dark'] as const)('the pages in %s', (scheme) => {
  const c = COLORS[scheme]
  const rgb = (token: ColorToken): Rgb => rgbOf(parse(c[token]))
  const surface = rgb('surface-editor')
  const card = over(parse(c['fill-card']), surface)
  // Mirrors --brand-fill in assets.ts: the dark button is deepened toward the window colour.
  const brand = rgb('activity-level-4')
  const brandFill = scheme === 'dark' ? mixOklab(brand, 0.62, rgb('surface-window')) : brand
  const brandHover =
    scheme === 'dark'
      ? mixOklab(brand, 0.68, rgb('surface-window'))
      : mixOklab(brand, 0.84, rgb('text-primary'))

  const pairs: [string, Rgb, Rgb][] = [
    ['text on the page', rgb('text-primary'), surface],
    ['lead, muted, label and status text', rgb('text-secondary'), surface],
    ['link', rgb('accent-text'), surface],
    ['key text', rgb('text-primary'), card],
    ['button text', rgb('text-primary'), rgb('fill-button')],
    ['field text', rgb('text-primary'), rgb('fill-field')],
    ['primary button', rgb('accent-on-fill'), brandFill],
    ['primary button hovered', rgb('accent-on-fill'), brandHover],
  ]
  it.each(pairs)('%s reaches 4.5:1', (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(MIN)
  })

  it('uses only text colours this test checks', async () => {
    const css = await assetResponse(ASSETS.style, 'GET')!.text()
    const used = new Set(
      [...css.matchAll(/(?<!-)color:var\(--color-([a-z-]+)\)/g)].map((m) => m[1]),
    )
    expect([...used].sort()).toEqual(
      ['accent-on-fill', 'accent-text', 'text-primary', 'text-secondary'].sort(),
    )
  })
})

describe('the licence email', () => {
  const mail = licenceMail('buyer@example.test', 'issued', ['devot1.a.b'])
  const style = /<style>(.*?)<\/style>/s.exec(mail.html)![1]!
  const darkRules = [...style.matchAll(/\.([\w-]+)\{([^}]*)\}/g)].map(
    (m) => [m[1]!, m[2]!] as const,
  )
  const decl = (css: string, prop: string) =>
    new RegExp(`(?:^|;)${prop}:\\s*([^;!]+)`).exec(css)?.[1]?.trim()

  const elements = [...mail.html.matchAll(/<(?:p|div|a)\b([^>]*)>/g)]
    .map((m) => ({
      cls: /class="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
      inline: /style="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
    }))
    .filter((e) => decl(e.inline, 'color'))

  it('colours some text', () => expect(elements.length).toBeGreaterThan(4))

  it.each(['light', 'dark'] as const)('every text colour reaches 4.5:1 in %s', (scheme) => {
    const page = rgbOf(parse(COLORS[scheme]['surface-editor']))
    for (const e of elements) {
      const pick = (prop: string) => {
        const rule =
          scheme === 'dark'
            ? darkRules.find(([cls, body]) => e.cls.split(' ').includes(cls) && decl(body, prop))
            : undefined
        return decl(rule ? rule[1] : e.inline, prop)
      }
      const fgCss = pick('color')!
      const bgCss = pick('background')
      const bg = bgCss ? over(parse(bgCss), page) : page
      expect(
        ratio(over(parse(fgCss), bg), bg),
        `${scheme} ${e.cls || e.inline.slice(0, 40)}: ${fgCss} on ${bgCss ?? 'page'}`,
      ).toBeGreaterThanOrEqual(MIN)
    }
  })
})
