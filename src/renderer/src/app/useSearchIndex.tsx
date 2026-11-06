import { useEffect, useRef, useState } from 'react'
import type { Core } from '../core-client'
import { currentLocale } from '../i18n'
import { SearchIndexNotice } from '../SearchIndexNotice'
import { REBUILD_SEARCH_INDEX, rebuildSearchIndex, type RebuildState } from '../searchIndex'
import { useStable } from '../stable'
import { listenHere, unlistenLater } from '../windowEvents'

export function useSearchIndex(core: Core | undefined, refresh: (c: Core) => Promise<unknown>) {
  const [indexState, setIndexState] = useState<RebuildState>()
  const indexRunning = useRef(false)
  // Help > Rebuild Search Index and the palette command. The notes stay usable
  // meanwhile; their reads and saves wait for the one statement. Rust refuses
  // a second rebuild while one runs, but the window does not ask.
  const rebuildIndex = useStable(async () => {
    if (!core || indexRunning.current) return
    indexRunning.current = true
    try {
      await rebuildSearchIndex(setIndexState, () => refresh(core))
    } finally {
      indexRunning.current = false
    }
  })
  useEffect(() => {
    const run = () => void rebuildIndex()
    window.addEventListener(REBUILD_SEARCH_INDEX, run)
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          listenHere('devot://rebuild-search-index', () =>
            window.dispatchEvent(new CustomEvent(REBUILD_SEARCH_INDEX)),
          ),
        )
    return () => {
      window.removeEventListener(REBUILD_SEARCH_INDEX, run)
      unlisten?.()
    }
  }, [rebuildIndex])
  useEffect(() => {
    if (indexState?.phase !== 'done') return
    const timer = setTimeout(() => setIndexState(undefined), 5000)
    return () => clearTimeout(timer)
  }, [indexState])
  const notice = indexState ? (
    <SearchIndexNotice
      state={indexState}
      locale={currentLocale()}
      onDismiss={() => setIndexState(undefined)}
    />
  ) : null
  return { rebuildIndex, notice }
}
