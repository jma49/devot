// Note list orders: by title, date created or date updated, either way. An
// order is a view preference, not note data: it is never stored with notes.

import type { NoteSummary } from './storage'

export type NoteSortKey = 'title' | 'created' | 'updated'
export type NoteSortDirection = 'asc' | 'desc'

export interface NoteSort {
  key: NoteSortKey
  /** For dates, `desc` is newest first; for titles, `asc` is A to Z. */
  direction: NoteSortDirection
}

/** The six orders, in the order a menu lists them. */
export const NOTE_SORTS: readonly NoteSort[] = [
  { key: 'title', direction: 'asc' },
  { key: 'title', direction: 'desc' },
  { key: 'updated', direction: 'desc' },
  { key: 'updated', direction: 'asc' },
  { key: 'created', direction: 'desc' },
  { key: 'created', direction: 'asc' },
]

/** The order the list has until the user picks another: newest updated first. */
export const DEFAULT_NOTE_SORT: NoteSort = { key: 'updated', direction: 'desc' }

/** An order's stable name, such as `title-asc`. */
export type NoteSortId = `${NoteSortKey}-${NoteSortDirection}`

/** The stable name of an order. */
export function noteSortId(sort: NoteSort): NoteSortId {
  return `${sort.key}-${sort.direction}`
}

/** The order named by `noteSortId`, or undefined for anything else. */
export function parseNoteSort(value: unknown): NoteSort | undefined {
  return NOTE_SORTS.find((sort) => noteSortId(sort) === value)
}

const collators = new Map<string, Intl.Collator>()

/** Locale-aware title comparison: numbers by value, accents and case ignored. */
function collator(locales: string | readonly string[]): Intl.Collator {
  const key = typeof locales === 'string' ? locales : locales.join(',')
  let found = collators.get(key)
  if (!found) {
    const options: Intl.CollatorOptions = { numeric: true, sensitivity: 'base' }
    try {
      found = new Intl.Collator(typeof locales === 'string' ? locales : [...locales], options)
    } catch {
      // A malformed locale tag: fall back to the runtime's default.
      found = new Intl.Collator(undefined, options)
    }
    collators.set(key, found)
  }
  return found
}

/** What sorting reads from a note. */
export type SortableNote = Pick<NoteSummary, 'id' | 'title' | 'createdAt' | 'updatedAt'>

/**
 * The notes in `sort` order, as a new array. Titles compare with the
 * collation of `locales`; equal titles put the newest updated first, and
 * untitled notes come last either way. Equal dates fall back to the ID
 * (UUIDv7, so creation order) in the same direction.
 */
export function sortNotes<T extends SortableNote>(
  notes: readonly T[],
  sort: NoteSort,
  locales: string | readonly string[],
): T[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const newest = (a: T, b: T) => b.updatedAt - a.updatedAt || byId(b, a)
  if (sort.key !== 'title') {
    const field = sort.key === 'created' ? 'createdAt' : 'updatedAt'
    return [...notes].sort((a, b) => sign * (a[field] - b[field] || byId(a, b)))
  }
  const { compare } = collator(locales)
  return [...notes].sort((a, b) => {
    if (!a.title || !b.title) return (a.title ? -1 : b.title ? 1 : 0) || newest(a, b)
    return sign * compare(a.title, b.title) || newest(a, b)
  })
}
