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
