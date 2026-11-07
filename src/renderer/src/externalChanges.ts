// Changes other processes make to the database while Devot runs, such as a
// note an outside writer creates. Rust notices them (src-tauri/src/watch.rs) and
// sends `devot://db-changed`; the page re-sends it as a window event, which
// the UI tests can send too, merges the changes into the notes the core holds
// and reloads its lists (app/useExternalMerge.ts). A write that knows the only
// notes it changed (an HTTP API append, say) names them, and only their rows
// are read again.
import { useEffect, useRef } from 'react'
import { listenHere, unlistenLater } from './windowEvents'

export const DB_CHANGED = 'devot:db-changed'
/**
 * Sent each time the app has reloaded its lists, whatever changed the notes,
 * and when a note window's save or title reaches the core. Its `detail` lists
 * the IDs of the notes that changed; with none (null), any may have.
 */
export const NOTES_LOADED = 'devot:notes-loaded'

/** A DB_CHANGED event; `notes` names the notes a write changed when it changed nothing else. */
export const dbChanged = (notes?: readonly string[]) =>
  new CustomEvent(DB_CHANGED, notes ? { detail: { notes } } : undefined)

export const notesLoaded = (notes?: readonly string[]) =>
  new CustomEvent(NOTES_LOADED, notes ? { detail: notes } : undefined)

/** What the changes heard since the last reload touched: some notes alone, or anything. */
export type ChangeScope = ReadonlySet<string> | 'all'

export function widened(scope: ChangeScope | undefined, event: Event): ChangeScope {
  if (scope === 'all') return scope
  const detail = (event as CustomEvent<unknown>).detail
  const notes: unknown =
    typeof detail === 'object' && detail !== null && 'notes' in detail ? detail.notes : undefined
  if (!Array.isArray(notes) || !notes.every((id) => typeof id === 'string')) return 'all'
  return new Set([...(scope ?? []), ...notes])
}

/** Whether a NOTES_LOADED event may concern any of `ids`. */
export function loadedAny(event: Event, ids: readonly string[]): boolean {
  const named = (event as CustomEvent<unknown>).detail
  return !Array.isArray(named) || named.some((id) => ids.includes(id as string))
}

export function useExternalChanges(
  onChange: ((notes: readonly string[] | undefined) => Promise<void>) | undefined,
) {
  const latest = useRef(onChange)
  const missed = useRef(false)
  useEffect(() => {
    latest.current = onChange
    if (onChange && missed.current) {
      missed.current = false
      window.dispatchEvent(dbChanged())
    }
  }, [onChange])

  useEffect(() => {
    // Changes that arrive during a reload get one more reload after it, over all of them.
    let running: Promise<void> | undefined
    let pending: ChangeScope | undefined
    const start = () => {
      const run = latest.current
      if (!run) {
        missed.current = true
        return
      }
      if (running || !pending) return
      const scope = pending
      pending = undefined
      running = run(scope === 'all' ? undefined : [...scope])
        .catch(() => console.warn('W_EXTERNAL_RELOAD_FAILED'))
        .finally(() => {
          running = undefined
          start()
        })
    }
    const reload = (event: Event) => {
      pending = widened(pending, event)
      start()
    }
    window.addEventListener(DB_CHANGED, reload)
    // Rust sends the event to each main window in turn; the event module's `listen` would hear all of them.
    const unlisten = DEVOT_UI_TEST
      ? undefined
      : unlistenLater(
          listenHere('devot://db-changed', () => window.dispatchEvent(dbChanged())),
          () => console.warn('W_EXTERNAL_LISTEN_FAILED'),
        )
    return () => {
      window.removeEventListener(DB_CHANGED, reload)
      unlisten?.()
    }
  }, [])
}
