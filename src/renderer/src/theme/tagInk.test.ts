import { describe, expect, it } from 'vitest'
import { contrastRatio, parseColor } from './contrast'
import { tagBackdrops, tagChipFills, tagInk, type TagAppearance } from './tagInk'
import { dark, ivoryDark, ivoryLight, light } from './tokens'

const WORST_CASES = [
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#ffffff',
  '#fefefe',
  '#000000',
  '#010101',
  '#0a0a14',
  '#ff0000',
  '#0000ff',
  '#ff00ff',
  '#808080',
  '#777777',
  '#c8483c',
]
const APPEARANCES: readonly TagAppearance[] = ['light', 'dark']

describe('tagInk', () => {
  it.each(APPEARANCES)('keeps label and icon readable on every %s surface', (appearance) => {
    for (const hex of WORST_CASES) {
      const color = parseColor(hex).rgb
      const ink = tagInk(hex, appearance)
      const text = parseColor(ink.text).rgb
      const icon = parseColor(ink.icon).rgb
      for (const fill of tagChipFills(color, appearance)) {
        expect(contrastRatio(text, fill), `${hex} text`).toBeGreaterThanOrEqual(4.5)
      }
      for (const backdrop of tagBackdrops(appearance)) {
        expect(contrastRatio(icon, backdrop), `${hex} icon`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('measures against every theme, each surface included', () => {
    for (const [appearance, themes] of [
      ['light', [light, ivoryLight]],
      ['dark', [dark, ivoryDark]],
    ] as const) {
      const backdrops = tagBackdrops(appearance).map((rgb) => rgb.join())
      for (const theme of themes) {
        for (const token of ['color.surface.list', 'color.surface.editor', 'color.phone.card']) {
          expect(backdrops).toContain(
            parseColor((theme as Record<string, string>)[token]!).rgb.join(),
          )
        }
      }
    }
  })

  it('leaves a colour alone when it already reads, and keeps its hue when it does not', () => {
    expect(tagInk('#7a1020', 'light').text).toBe('#7a1020')
    expect(tagInk('#ffd0d8', 'dark').icon).toBe('#ffd0d8')
    const [r, g, b] = parseColor(tagInk('#ffff00', 'light').text).rgb
    expect(r).toBe(g)
    expect(b).toBe(0)
  })

  it('reads the same every time', () => {
    expect(tagInk('#123456', 'dark')).toEqual(tagInk('#123456', 'dark'))
  })
})
