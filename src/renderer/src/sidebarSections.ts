// The sidebar sections a window keeps collapsed (Status, Tags). Like focus
// mode and the hidden sidebar this is a view preference of one window: it
// lives in the webview's local storage under the window's label, never in
// the note database, and never syncs.
import { current } from './focus'

/** The sections with a chevron that folds them. */
export type CollapsibleSection = 'status' | 'tags'

const SECTIONS: readonly CollapsibleSection[] = ['status', 'tags']

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

/** Reads and writes one window's collapsed sections; storage failures mean "none collapsed". */
export function sectionStore(storage: KeyValue | undefined, label: string) {
  const key = `devot.sidebarCollapsed.${label}`
  const booksKey = `devot.sidebarBooksCollapsed.${label}`
  return {
    load(): ReadonlySet<CollapsibleSection> {
      try {
        const value: unknown = JSON.parse(storage?.getItem(key) ?? '[]')
        return new Set(
          Array.isArray(value) ? SECTIONS.filter((section) => value.includes(section)) : [],
        )
      } catch {
        return new Set()
      }
    },
    save(collapsed: ReadonlySet<CollapsibleSection>) {
      try {
        storage?.setItem(key, JSON.stringify(SECTIONS.filter((s) => collapsed.has(s))))
      } catch {
        console.warn('W_SIDEBAR_SECTIONS_SAVE_FAILED')
      }
    },
    /** The IDs of the notebooks folded shut; an ID of a deleted notebook is harmless. */
    loadBooks(): ReadonlySet<string> {
      try {
        const value: unknown = JSON.parse(storage?.getItem(booksKey) ?? '[]')
        return new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [])
      } catch {
        return new Set()
      }
    },
    saveBooks(folded: ReadonlySet<string>) {
      try {
        storage?.setItem(booksKey, JSON.stringify([...folded]))
      } catch {
        console.warn('W_SIDEBAR_BOOKS_SAVE_FAILED')
      }
    },
  }
}

export type SectionStore = ReturnType<typeof sectionStore>

/** The store of the current window. */
export const currentSectionStore = (): SectionStore => current(sectionStore)
