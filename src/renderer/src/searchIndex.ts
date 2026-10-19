// Rebuild Search Index (Help menu and command palette; see
// src-tauri/src/commands/search_index.rs). The menu reaches the page as a
// Tauri event, which App re-sends as this window event so the UI tests can
// send it too.
import { invoke } from './ipc'
import { errorCode } from '../../core/errors'

export const REBUILD_SEARCH_INDEX = 'devot:rebuild-search-index'

export type RebuildState =
  | { phase: 'running' }
  | { phase: 'done'; notes: number }
  | { phase: 'failed'; code: string }

/**
 * Rebuilds the index and tells `show` how it goes. The rebuild is one
 * statement that reports no progress, so the running state is indeterminate.
 * After a rebuild `reload` runs, which lists the notes again and re-runs the
 * current search; its own failure does not make the rebuild one.
 */
export async function rebuildSearchIndex(
  show: (state: RebuildState) => void,
  reload: () => Promise<unknown>,
): Promise<void> {
  show({ phase: 'running' })
  let notes: number
  try {
    notes = await invoke<number>('search_index_rebuild')
  } catch (error) {
    show({ phase: 'failed', code: errorCode(error) })
    return
  }
  await reload().catch(() => console.warn('W_SEARCH_REBUILD_RELOAD_FAILED'))
  show({ phase: 'done', notes })
}
