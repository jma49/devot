// The text and icon colours of a tag in a custom colour. A custom colour has no tokens, so these
// are worked out for each appearance over every built-in theme's surfaces, by the rules the
// `color.tag-text.*` and `color.tag-icon.*` tokens follow. The dot draws the colour as given.
import { composite, parseColor, readableOn, toHex, type Rgb } from './contrast'
import { dark, ivoryDark, ivoryLight, light, sizes } from './tokens'

export type TagAppearance = 'light' | 'dark'

export interface TagInk {
  /** The chip's label: 4.5:1 on the chip, at rest and under the pointer, on any surface. */
  text: string
  /** A mark drawn in the colour: 3:1 on any surface. */
  icon: string
}

type Theme = Record<string, string>
const THEMES: Record<TagAppearance, readonly Theme[]> = {
  light: [light, ivoryLight],
  dark: [dark, ivoryDark],
}
const SURFACES = [
  'color.surface.list',
  'color.surface.editor',
  'color.surface.sidebar-opaque',
  'color.surface.popover',
  'color.phone.background',
  'color.phone.card',
]

/** Above AA, to stay clear of rounding, as the accent colours do. */
const TEXT_TARGET = 4.6
const ICON_TARGET = 3.1

const solid = (theme: Theme, token: string): Rgb => parseColor(theme[token]!).rgb

/** The surfaces a tag sits on, with the selected row's wash over each. */
export function tagBackdrops(appearance: TagAppearance): Rgb[] {
  return THEMES[appearance].flatMap((theme) => {
    const wash = parseColor(theme['color.fill.row-selected-unemphasized']!)
    return SURFACES.flatMap((token) => {
      const surface = solid(theme, token)
      return [surface, composite(wash, surface)]
    })
  })
}

const BACKDROPS: Record<TagAppearance, Rgb[]> = {
  light: tagBackdrops('light'),
  dark: tagBackdrops('dark'),
}

/** The chip fills a colour makes, at the strengths `.chip.tag-chip` mixes it. */
export function tagChipFills(color: Rgb, appearance: TagAppearance): Rgb[] {
  return [sizes['opacity.tag.fill'], sizes['opacity.tag.fill-active']].flatMap((alpha) =>
    BACKDROPS[appearance].map((b) => composite({ rgb: color, alpha: Number(alpha) }, b)),
  )
}

export function tagInk(hex: string, appearance: TagAppearance): TagInk {
  const color = parseColor(hex).rgb
  const direction = appearance === 'light' ? 'darker' : 'lighter'
  return {
    text: toHex(readableOn(color, tagChipFills(color, appearance), direction, TEXT_TARGET)),
    icon: toHex(readableOn(color, BACKDROPS[appearance], direction, ICON_TARGET)),
  }
}
