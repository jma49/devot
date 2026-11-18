import { canSearchPaletteBody, type PaletteEntry, type PaletteState } from './results'

export type PaletteBodySearch = (query: string) => Promise<readonly PaletteEntry[]>

/**
 * Coordinates debounced full-text body searches with a monotonic generation ID so stale responses
 * never overwrite newer typing, and clearing/closing drops in-flight replies at once.
 */
export function createBodySearchController({
  search,
  debounceMs = 60,
  onResults,
}: {
  search: PaletteBodySearch
  debounceMs?: number
  onResults: (rows: readonly PaletteEntry[]) => void
}) {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastQuery = ''

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const reset = () => {
    generation += 1
    lastQuery = ''
    clearTimer()
    onResults([])
  }

  const update = (state: PaletteState) => {
    clearTimer()
    if (!canSearchPaletteBody(state)) {
      reset()
      return
    }
    const query = state.query.trim()
    if (query === lastQuery) return
    const id = ++generation
    lastQuery = ''
    onResults([])
    const run = () => {
      timer = undefined
      void search(state.query)
        .then((rows) => {
          if (id !== generation) return
          lastQuery = query
          onResults(rows)
        })
        .catch(() => {
          if (id !== generation) return
          lastQuery = ''
          onResults([])
        })
    }
    if (debounceMs <= 0) run()
    else timer = setTimeout(run, debounceMs)
  }

  return { update, reset }
}
