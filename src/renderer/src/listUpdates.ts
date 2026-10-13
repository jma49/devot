// Changes to the note lists the window makes itself, without reloading them.
// Each keeps the objects of the notes that did not change (their rows then
// do not render again) and returns the same list when nothing changed.
import type { BookRecord, NoteSummary } from '../../core'
import { TEMPLATES_BOOK_ID } from '../../core/books'
import { filterNotes, type NoteFilter } from '../../core/tags'
import type { Selection } from './Sidebar'

/**
 * `list` with each note written since (`written`: its ID and new
 * `updatedAt`) dated as written. A write no newer than the date listed (an
 * earlier save landing late) changes nothing.
 */
export function withWrites<T extends NoteSummary>(
  list: T[],
  written: ReadonlyMap<string, number>,
): T[] {
  let changed = false
  const next = list.map((n) => {
    const at = written.get(n.id)
    if (at === undefined || at <= n.updatedAt) return n
    changed = true
    return { ...n, updatedAt: at }
  })
  return changed ? next : list
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

/** Whether two summaries show the same. */
function sameNote(a: NoteSummary, b: NoteSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.bookId === b.bookId &&
    a.status === b.status &&
    a.pinned === b.pinned &&
    a.excerpt === b.excerpt &&
    sameIds(a.tagIds, b.tagIds)
  )
}

/**
 * A reloaded list (`next`) with each note that did not change since `prev`
 * kept as its earlier object; `prev` itself when nothing changed at all.
 */
export function keepUnchanged<T extends NoteSummary>(prev: T[], next: T[]): T[] {
  const before = new Map(prev.map((n) => [n.id, n]))
  let changed = prev.length !== next.length
  const kept = next.map((n, i) => {
    const old = before.get(n.id)
    if (old && sameNote(old, n)) {
      if (prev[i] !== old) changed = true
      return old
    }
    changed = true
    return n
  })
  return changed ? kept : prev
}

/** `list` with the note `id` titled `title`. */
export function retitled<T extends NoteSummary>(list: T[], id: string, title: string): T[] {
  let changed = false
  const next = list.map((n) => {
    if (n.id !== id || n.title === title) return n
    changed = true
    return { ...n, title }
  })
  return changed ? next : list
}

/** A view of the note list that is not search results. */
export type ListView =
  | { kind: 'trash' }
  | { kind: 'templates' }
  | { kind: 'library'; bookId: string | null; filter: NoteFilter | null }

/**
 * Whether `view` lists the live note `note`: the Trash never does,
 * Templates lists templates only, and the library the other notes in its
 * notebook (or all of them) that match its filter.
 */
export function viewLists(
  view: ListView,
  note: NoteSummary,
  books: readonly BookRecord[],
): boolean {
  const template = note.bookId === TEMPLATES_BOOK_ID
  if (view.kind !== 'library') return view.kind === 'templates' && template
  if (template) return false
  return filterNotes([note], books, { bookId: view.bookId, by: view.filter }).length > 0
}

/** The view that always lists a note: Templates, its notebook, or All Notes (with no filter). */
export function homeOf(note: Pick<NoteSummary, 'bookId'>): Selection {
  if (note.bookId === TEMPLATES_BOOK_ID) return { kind: 'templates' }
  return note.bookId ? { kind: 'book', id: note.bookId } : { kind: 'all' }
}

/** Whether two counts (by notebook, status or tag) are the same. */
export function sameCounts<K>(a: ReadonlyMap<K, number>, b: ReadonlyMap<K, number>): boolean {
  if (a.size !== b.size) return false
  for (const [key, count] of a) if (b.get(key) !== count) return false
  return true
}
