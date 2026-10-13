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
 * pixels to a CSS pixel on a Retina screen.
 */
const PIXELS_PER_POINT = 2

/** A symbol's size at its point size, in CSS pixels, read from its PNG's header; null if unreadable. */
export function symbolSize(dataUrl: string): { width: number; height: number } | null {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 32)
  let header: string
  try {
    header = atob(base64)
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
 * How a symbol sits in its `box` (CSS pixels, square): at its own size, so
 * every symbol keeps the same scale and weight and none is stretched or
 * blurred, centred on the box. A symbol wider or taller than the box
 * overhangs it evenly; the box keeps its place in the layout.
 */
export function symbolStyle(dataUrl: string, box: number): Record<string, string> {
  const mask = `url("${dataUrl}")`
  const size = symbolSize(dataUrl)
  if (!size) return { maskImage: mask, WebkitMaskImage: mask }
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    maskSize: '100% 100%',
    WebkitMaskSize: '100% 100%',
    width: `${size.width}px`,
    height: `${size.height}px`,
    margin: `${(box - size.height) / 2}px ${(box - size.width) / 2}px`,
  }
}
