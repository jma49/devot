import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { flatten, type TokenTree } from '../../scripts/tokens/compile'
import {
  composite,
  contrastRatio,
  parseColor,
  type Rgb,
} from '../../src/renderer/src/theme/contrast'
import { dark, light, sizes } from '../../src/renderer/src/theme/tokens'

// Text and lines are tiers of one ink per appearance. Text tiers are solid and may move toward
// black or white only where contrast needs it; line tiers are the ink at the tier's alpha.

type Appearance = 'light' | 'dark'
const THEMES: Record<Appearance, Record<string, string>> = { light, dark }

const tree = (appearance: Appearance) =>
  JSON.parse(
    readFileSync(`design/tokens/themes/system.${appearance}.tokens.json`, 'utf8'),
  ) as TokenTree

interface Tiered {
  path: string
  tier: number
}

/** The theme tokens that name a tier (`$extensions.app.devot.tier`). */
function tiered(appearance: Appearance, group: 'text' | 'line'): Tiered[] {
  const raw = tree(appearance) as { color: Record<string, Record<string, unknown>> }
  return Object.entries(raw.color[group] ?? {}).flatMap(([name, token]) => {
    const tier = (token as { $extensions?: { 'app.devot'?: { tier?: number } } }).$extensions?.[
      'app.devot'
    ]?.tier
    return tier === undefined ? [] : [{ path: `color.${group}.${name}`, tier }]
  })
}

const rgb = (appearance: Appearance, path: string) => parseColor(THEMES[appearance][path]!)
const close = (a: Rgb, b: Rgb) => a.every((c, i) => Math.abs(c - b[i]!) <= 1)
const luminanceOrder = (colours: Rgb[]) => colours.map((c) => contrastRatio(c, [0, 0, 0]))

describe.each(['light', 'dark'] as const)('the %s tiers', (appearance) => {
  const theme = THEMES[appearance]
  const editor = rgb(appearance, 'color.surface.editor').rgb

  it('has the text tiers: 87, 80, 60, 40 (placeholder and disabled) and 95', () => {
    expect(Object.fromEntries(tiered(appearance, 'text').map((t) => [t.path, t.tier]))).toEqual({
      'color.text.primary': 0.87,
      'color.text.secondary': 0.6,
      'color.text.tertiary': 0.4,
      'color.text.placeholder': 0.4,
      'color.text.hover': 0.8,
      'color.text.selected': 0.95,
      'color.text.disabled': 0.4,
    })
  })

  it('draws every text tier from the ink, moved only toward more contrast', () => {
    const ink = rgb(appearance, 'color.ink.text').rgb
    // Placeholders and disabled text are not held to text contrast: exactly the tier.
    const exempt = new Set(['color.text.placeholder', 'color.text.disabled'])
    const wrong = tiered(appearance, 'text').flatMap(({ path, tier }) => {
      const design = composite({ rgb: ink, alpha: tier }, editor)
      const token = rgb(appearance, path).rgb
      if (close(token, design)) return []
      // Moved (contrast.test.ts holds what for): further from the editor
      // than the tier, keeping the grey.
      const moved =
        !exempt.has(path) &&
        contrastRatio(token, editor) > contrastRatio(design, editor) &&
        new Set(token).size === 1
      return moved ? [] : [path]
    })
    expect(wrong).toEqual([])
  })

  it('draws borders at 15% (light) or 10% (dark) and internal dividers at 10% of the line ink', () => {
    const ink = rgb(appearance, 'color.ink.line').rgb
    const want = {
      'color.line.hairline': appearance === 'light' ? 0.15 : 0.1,
      'color.line.separator': 0.1,
    }
    expect(Object.fromEntries(tiered(appearance, 'line').map((t) => [t.path, t.tier]))).toEqual(
      want,
    )
    for (const [path, alpha] of Object.entries(want)) {
      expect(rgb(appearance, path).rgb).toEqual(ink)
      expect(rgb(appearance, path).alpha).toBeCloseTo(alpha, 3)
    }
  })

  it('steps the surfaces from the sidebar through the note list to the editor', () => {
    const [sidebar, list, page] = luminanceOrder(
      ['sidebar-opaque', 'list', 'editor'].map((s) => rgb(appearance, `color.surface.${s}`).rgb),
    )
    const stepped =
      appearance === 'light' ? sidebar! < list! && list! < page! : sidebar! > list! && list! > page!
    expect(stepped).toBe(true)
  })

  it('rests floating things on the two-layer shadow: 12% and 15% (light), 20% and 30% (dark)', () => {
    const want = appearance === 'light' ? [0.12, 0.15] : [0.2, 0.3]
    expect([
      parseColor(theme['color.shadow.popover-key']!).alpha,
      parseColor(theme['color.shadow.popover-ambient']!).alpha,
    ]).toEqual(want)
    expect([
      sizes['shadow.popover-y'],
      sizes['shadow.popover-key-blur'],
      sizes['shadow.popover-ambient-blur'],
    ]).toEqual(['2px', '4px', '10px'])
  })
})

describe('motion and state tokens', () => {
  it('times hover at 180 ms, toggles at 200 ms and colour changes at 400 ms', () => {
    expect(sizes['motion.duration.hover']).toBe('180ms')
    expect(sizes['motion.duration.toggle']).toBe('200ms')
    expect(sizes['motion.duration.color']).toBe('400ms')
    expect(sizes['motion.easing.out']).toMatch(/^cubic-bezier\(0, 0, /)
  })

  it('shows a toolbar tooltip after 400 ms', () => {
    expect(sizes['motion.delay.tooltip']).toBe('400ms')
  })

  it('draws the focus ring 2 px wide', () => {
    expect(sizes['size.focus-ring']).toBe('2px')
  })

  it('mixes a tag chip from its tag colour: 10/20%, under the pointer 20/30%, the dot 30%', () => {
    const base = flatten(
      JSON.parse(readFileSync('design/tokens/base.tokens.json', 'utf8')) as TokenTree,
    )
    const opacity = Object.fromEntries(
      base.filter((t) => t.path.startsWith('opacity.tag.')).map((t) => [t.path, t.value]),
    )
    expect(opacity).toEqual({
      'opacity.tag.fill': 0.1,
      'opacity.tag.border': 0.2,
      'opacity.tag.fill-active': 0.2,
      'opacity.tag.border-active': 0.3,
      'opacity.tag.dot': 0.3,
    })
  })
})
