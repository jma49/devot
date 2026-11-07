// Changes to the note lists the window makes itself, without reloading them.
// Each keeps the objects of the notes that did not change (their rows then
// do not render again) and returns the same list when nothing changed.
import type { BookRecord, NoteSummary } from '../../core'
import { TEMPLATES_BOOK_ID } from '../../core/books'
import { filterNotes, type NoteFilter } from '../../core/tags'
import type { Selection } from './Sidebar'

const madeFrom = new WeakMap<readonly NoteSummary[], readonly NoteSummary[]>()

const inPlace = <T extends NoteSummary>(list: T[], next: T[]) => {
  madeFrom.set(next, list)
  return next
}

/** The list `list` was made from by changing notes in their places (`withWrites`, `withSummaries`, `retitled`), if it was. */
export const earlierList = <T extends NoteSummary>(list: readonly T[]) =>
  madeFrom.get(list) as readonly T[] | undefined

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
  return changed ? inPlace(list, next) : list
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

function sameNote(a: NoteSummary, b: NoteSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.bodyVersion === b.bodyVersion &&
    a.bookId === b.bookId &&
    a.status === b.status &&
    a.pinned === b.pinned &&
    a.excerpt === b.excerpt &&
    sameIds(a.tagIds, b.tagIds)
  )
}

/** The notes of `next` that are new objects, each with the one it replaced, when `next` lists the notes of `prev` in the same places and at most `most` of them changed. */
export function changedInPlace<T extends NoteSummary>(
  prev: readonly T[],
  next: readonly T[],
  most = 64,
): (readonly [was: T, now: T])[] | undefined {
  if (prev.length !== next.length) return undefined
  const changed: (readonly [T, T])[] = []
  for (let i = 0; i < next.length; i += 1) {
    const was = prev[i]!
    const now = next[i]!
    if (was === now) continue
    if (was.id !== now.id || changed.length === most) return undefined
    changed.push([was, now])
  }
  return changed
}

/** Whether a note counts in the same notebooks, statuses, tags and pinned notes, and passes the same filters. */
export const countsAlike = (a: NoteSummary, b: NoteSummary) =>
  a.bookId === b.bookId &&
  a.status === b.status &&
  a.pinned === b.pinned &&
  sameIds(a.tagIds, b.tagIds)

/**
 * `sorted` with each changed note in the place `compare` gives it, or in the
 * place of the one it replaced when the order is the given one (no
 * `compare`); a note `sorted` does not list stays out. `sorted` itself when
 * none of them is listed.
 */
export function movedInOrder<T>(
  sorted: T[],
  changed: readonly (readonly [was: T, now: T])[],
  compare?: (a: T, b: T) => number,
): T[] {
  let next = sorted
  for (const [was, now] of changed) {
    const at = next.indexOf(was)
    if (at < 0) continue
    if (next === sorted) next = [...sorted]
    if (!compare) {
      next[at] = now
      continue
    }
    next.splice(at, 1)
    let low = 0
    let high = next.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (compare(next[mid]!, now) < 0) low = mid + 1
      else high = mid
    }
    next.splice(low, 0, now)
  }
  return next
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

/** `list` with the rows of the notes read again (`read`) in their places; notes it does not list are left out. */
export function withSummaries<T extends NoteSummary>(list: T[], read: readonly T[]): T[] {
  const byId = new Map(read.map((n) => [n.id, n]))
  let changed = false
  const next = list.map((n) => {
    const fresh = byId.get(n.id)
    if (!fresh || sameNote(n, fresh)) return n
    changed = true
    return fresh
  })
  return changed ? inPlace(list, next) : list
}

/** The IDs of the notes listed in only one of `prev` and `next`, or listed differently. */
export function changedNotes(prev: readonly NoteSummary[], next: readonly NoteSummary[]): string[] {
  const before = new Map(prev.map((n) => [n.id, n]))
  const changed: string[] = []
  for (const n of next) {
    const old = before.get(n.id)
    before.delete(n.id)
    if (!old || !sameNote(old, n)) changed.push(n.id)
  }
  return [...changed, ...before.keys()]
}

export function retitled<T extends NoteSummary>(list: T[], id: string, title: string): T[] {
  let changed = false
  const next = list.map((n) => {
    if (n.id !== id || n.title === title) return n
    changed = true
    return { ...n, title }
  })
  return changed ? inPlace(list, next) : list
}

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

export function homeOf(note: Pick<NoteSummary, 'bookId'>): Selection {
  if (note.bookId === TEMPLATES_BOOK_ID) return { kind: 'templates' }
  return note.bookId ? { kind: 'book', id: note.bookId } : { kind: 'all' }
}

export function sameCounts<K>(a: ReadonlyMap<K, number>, b: ReadonlyMap<K, number>): boolean {
  if (a.size !== b.size) return false
  for (const [key, count] of a) if (b.get(key) !== count) return false
  return true
}

type SearchRow = { id: string; name: string; count: number | null }

/** The saved search rows show the same: a note write that changes no count renders no sidebar. */
export function sameSearchRows(a: readonly SearchRow[], b: readonly SearchRow[]): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i]
      return other?.id === row.id && other.name === row.name && other.count === row.count
    })
  )
}
