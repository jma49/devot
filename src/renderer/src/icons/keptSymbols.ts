// Placed symbols kept in localStorage across launches, so a launch draws only what the last one did not.
// A cache: anything unreadable is drawn again, and what fails to save is drawn again next launch.
import type { SymbolImage } from './symbols'

const KEY = 'devot.placedSymbols'
const MOST = 300
const SAVE_DELAY_MS = 2_000

interface Saved {
  stamp: string
  images: [key: string, url: string, side: number][]
}

export interface KeptSymbols {
  /** The images an earlier launch of the same `stamp` placed, by their placed key. */
  readonly images: Map<string, SymbolImage>
  /** Keeps `image`, saved a moment later with the others placed meanwhile; the oldest go past `MOST`. */
  keep(key: string, image: SymbolImage): void
}

function readSaved(store: Storage | undefined, stamp: string): Map<string, SymbolImage> {
  try {
    const saved = JSON.parse(store?.getItem(KEY) ?? 'null') as Saved | null
    if (saved?.stamp !== stamp || !Array.isArray(saved.images)) return new Map()
    return new Map(
      saved.images
        .filter(
          ([key, url, side]) =>
            typeof key === 'string' &&
            typeof url === 'string' &&
            typeof side === 'number' &&
            side > 0,
        )
        .map(([key, url, side]) => [key, { url, side }]),
    )
  } catch {
    return new Map()
  }
}

/** `stamp` names the build: images of another are never read. Without a store (tests, workers, the dev server) nothing is kept. */
export function keptSymbols(store: () => Storage | undefined, stamp: string): KeptSymbols {
  const images = readSaved(store(), stamp)
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    timer = undefined
    const kept = [...images].slice(-MOST).map(([key, { url, side }]) => [key, url, side])
    try {
      store()?.setItem(KEY, JSON.stringify({ stamp, images: kept }))
    } catch {
      // Full or refused: the next launch draws these again.
    }
  }
  return {
    images,
    keep(key, image) {
      images.delete(key)
      images.set(key, image)
      timer ??= setTimeout(save, SAVE_DELAY_MS)
    },
  }
}
