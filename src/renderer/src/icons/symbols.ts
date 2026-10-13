// SF Symbols rendered by Rust (`symbol_png`), cached per name, point size and
// appearance. The PNGs are black; the UI tints them through a CSS mask.
import symbolsJson from '../../../../design/icons/symbols.json'

export type IconName = keyof typeof symbolsJson.symbols
export type Appearance = 'light' | 'dark'
/** Renders a symbol and resolves to base64 PNG data. */
export type RenderSymbol = (name: string, pointSize: number) => Promise<string>

export const ICONS = Object.keys(symbolsJson.symbols) as IconName[]

export function symbolFor(icon: IconName): string {
  return symbolsJson.symbols[icon]
}

export interface SymbolCache {
  /** A `data:` URL for the symbol; concurrent requests share one render. */
  get(name: string, pointSize: number, appearance: Appearance): Promise<string>
}

export function createSymbolCache(render: RenderSymbol): SymbolCache {
  const entries = new Map<string, Promise<string>>()
  return {
    get(name, pointSize, appearance) {
      const key = `${name}@${pointSize}/${appearance}`
      let entry = entries.get(key)
      if (!entry) {
        entry = render(name, pointSize).then((png) => `data:image/png;base64,${png}`)
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
 * (`symbol_png`): shown at half its pixels in CSS pixels, a symbol keeps
 * its own width and height at the point size asked for, with two device
 * pixels to a CSS pixel on a Retina screen, so its edges stay crisp.
 */
export const PIXELS_PER_POINT = 2

/** A rectangle in CSS pixels. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A rendered symbol: its data URL, its size in CSS pixels, and where its ink is inside that. */
export interface SymbolImage {
  url: string
  width: number
  height: number
  ink: Box
}

/** A symbol's size in CSS pixels, read from its PNG's header; null if unreadable. */
export function symbolSize(dataUrl: string): { width: number; height: number } | null {
  const start = dataUrl.indexOf(',') + 1
  let header: string
  try {
    header = atob(dataUrl.slice(start, start + 32))
  } catch {
    return null
  }
  if (header.length < 24 || header.slice(1, 4) !== 'PNG') return null
  const at = (i: number) =>
    ((header.charCodeAt(i) << 24) |
      (header.charCodeAt(i + 1) << 16) |
      (header.charCodeAt(i + 2) << 8) |
      header.charCodeAt(i + 3)) >>>
    0
  return { width: at(16) / PIXELS_PER_POINT, height: at(20) / PIXELS_PER_POINT }
}

/**
 * The ink of a rendered symbol: the bounds of its pixels more than a
 * quarter opaque (`alpha` holds one value per pixel, row by row), in CSS
 * pixels; null when it has none.
 */
export function inkBounds(alpha: ArrayLike<number>, width: number, height: number): Box | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if ((alpha[y * width + x] ?? 0) <= 64) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  if (right < 0) return null
  const k = PIXELS_PER_POINT
  return { x: left / k, y: top / k, width: (right - left + 1) / k, height: (bottom - top + 1) / k }
}

/**
 * How a symbol sits in its `box` (CSS pixels, square): at its own size, its
 * ink centred on the box, on the half-pixel grid (whole device pixels on a
 * Retina screen). The margins keep the box's place in the layout; a symbol
 * larger than the box overhangs it.
 */
export function symbolStyle(image: SymbolImage, box: number): Record<string, string> {
  const snap = (n: number) => Math.round(n * 2) / 2
  const left = snap(box / 2 - (image.ink.x + image.ink.width / 2))
  const top = snap(box / 2 - (image.ink.y + image.ink.height / 2))
  const mask = `url("${image.url}")`
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    width: `${image.width}px`,
    height: `${image.height}px`,
    margin: `${top}px ${box - image.width - left}px ${box - image.height - top}px ${left}px`,
  }
}
