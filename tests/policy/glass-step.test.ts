import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { glassTint } from '../../src/renderer/src/sidebarGlass'

interface Rgba {
  rgb: [number, number, number]
  alpha: number
}

function surface(theme: string, name: string): Rgba {
  const tokens = JSON.parse(readFileSync(`design/tokens/themes/${theme}.tokens.json`, 'utf8')) as {
    color: { surface: Record<string, { $value: { components: Rgba['rgb']; alpha?: number } }> }
  }
  const token = tokens.color.surface[name]
  if (!token) throw new Error(`E_TEST_NO_TOKEN ${name}`)
  return { rgb: token.$value.components, alpha: token.$value.alpha ?? 1 }
}

function lightness([red, green, blue]: Rgba['rgb']): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const y = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y
}

const over = (top: Rgba, under: Rgba['rgb']): Rgba['rgb'] => [
  top.rgb[0] * top.alpha + under[0] * (1 - top.alpha),
  top.rgb[1] * top.alpha + under[1] * (1 - top.alpha),
  top.rgb[2] * top.alpha + under[2] * (1 - top.alpha),
]

it.each(['system.dark', 'ivory.dark'])(
  '%s fallback glass sits 4 to 8 L* above the sheet',
  (theme) => {
    const sheet = surface(theme, 'sheet').rgb
    const step = lightness(over(surface(theme, 'glass'), sheet)) - lightness(sheet)
    expect(step).toBeGreaterThanOrEqual(4)
    expect(step).toBeLessThanOrEqual(8)
  },
)

it('gives the native glass no tint in light and a tint in dark', () => {
  const css = readFileSync('src/renderer/src/theme/tokens.css', 'utf8')
  const tints = [...css.matchAll(/--color-surface-glass-tint: ([^;]+);/g)].map((m) =>
    glassTint(m[1] ?? ''),
  )
  expect(tints).toHaveLength(8)
  expect(tints.filter((tint) => tint === null)).toHaveLength(4)
  for (const tint of tints) if (tint) expect(tint).toMatch(/^#[0-9a-f]{8}$/)
})
