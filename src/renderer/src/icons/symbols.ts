// SF Symbols rendered by Rust (`symbol_png`), cached per name, point size and
// appearance. The PNGs are black; the UI tints them through a CSS mask.
import symbolsJson from '../../../../design/icons/symbols.json'

export type IconName = keyof typeof symbolsJson.symbols
export type Appearance = 'light' | 'dark'
export type SymbolWeight =
  | 'ultralight'
  | 'thin'
  | 'light'
  | 'regular'
  | 'medium'
  | 'semibold'
  | 'bold'
  | 'heavy'
  | 'black'
export type RenderSymbol = (
  name: string,
  pointSize: number,
  weight: SymbolWeight,
) => Promise<string>

export const ICONS = Object.keys(symbolsJson.symbols) as IconName[]

export function symbolFor(icon: IconName): string {
  return symbolsJson.symbols[icon]
}

export interface SymbolCache {
  get(
    name: string,
    pointSize: number,
    appearance: Appearance,
    weight?: SymbolWeight,
  ): Promise<string>
}

export function createSymbolCache(render: RenderSymbol): SymbolCache {
  const entries = new Map<string, Promise<string>>()
  return {
    get(name, pointSize, appearance, weight = 'regular') {
      const key = `${name}@${pointSize}/${appearance}/${weight}`
      let entry = entries.get(key)
      if (!entry) {
        entry = render(name, pointSize, weight).then((png) => `data:image/png;base64,${png}`)
        // A failed render is not cached, so the next request retries.
        entry.catch(() => entries.delete(key))
        entries.set(key, entry)
      }
      return entry
    },
  }
}

/**
 * Rust renders a symbol at twice its point size, one pixel to a point
 * (`symbol_png`), so a symbol asked for at `renderPoints` has `ratio` pixels
 * to a point: one device pixel to each of its pixels.
 */
export const PIXELS_PER_POINT = 2

/**
 * The point size every symbol shown in a `box` (CSS pixels) is drawn at: a
 * symbol at N points is a little taller than N pixels, so a typical one
 * fills the box. It depends on the box alone, never on the symbol, so every
 * icon of a size has one optical size and stroke.
 */
export const boxPoints = (box: number) => Math.round(box * 0.8)

/** The point size to ask Rust for so a symbol's pixels are `ratio` per point. */
export const renderPoints = (points: number, ratio: number) => (points * ratio) / PIXELS_PER_POINT

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A placed symbol: a square PNG of `side` CSS pixels, its ink centred on it. */
export interface SymbolImage {
  url: string
  side: number
}

/**
 * The ink of a rendered symbol: the bounds, in pixels, of its pixels more
 * than a quarter opaque (`rgba` holds four values per pixel, row by row, as
 * `ImageData` does); null when it has none.
 */
export function inkBounds(rgba: ArrayLike<number>, width: number, height: number): Box | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) <= 64) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  if (right < 0) return null
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/**
 * Where a rendered symbol of `width` by `height` pixels, its ink at `ink`,
 * goes on the square canvas that shows it in a `box` of CSS pixels at
 * `ratio` device pixels each: drawn at its own size, never scaled, at whole
 * pixels `x`, `y`, so its ink centre is within half a pixel of the canvas
 * centre. The canvas (`side` pixels) is the box, grown by whole pixels on
 * every side where the symbol is larger, so its centre stays the box's:
 * a wide symbol overhangs the box rather than shrink.
 */
export function placeInCanvas(width: number, height: number, ink: Box, box: number, ratio: number) {
  const boxSide = Math.round(box * ratio)
  const inkX = ink.x + ink.width / 2
  const inkY = ink.y + ink.height / 2
  // Rounding the offset moves the symbol up to half a pixel toward the far edge.
  const half = Math.max(boxSide / 2, inkX, width - inkX + 0.5, inkY, height - inkY + 0.5)
  const side = boxSide + 2 * Math.ceil(half - boxSide / 2)
  return { side, x: Math.round(side / 2 - inkX), y: Math.round(side / 2 - inkY) }
}

/**
 * How a placed symbol sits in its `box` (CSS pixels, square): shown at its
 * exact size with a mask of the same size, never scaled, centred on the box.
 * The margins keep the box's place in the layout; a canvas larger than the
 * box overhangs it evenly.
 */
export function symbolStyle(image: SymbolImage, box: number): Record<string, string> {
  const mask = `url("${image.url}")`
  const size = `${image.side}px ${image.side}px`
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: size,
    WebkitMaskSize: size,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: '0px 0px',
    WebkitMaskPosition: '0px 0px',
    width: `${image.side}px`,
    height: `${image.side}px`,
    margin: `${(box - image.side) / 2}px`,
  }
}
