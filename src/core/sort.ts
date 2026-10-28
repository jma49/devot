// Note list orders: by title, date created or date updated, either way. An order is a view preference, never stored with notes.

import type { NoteSummary } from './storage'

export type NoteSortKey = 'title' | 'created' | 'updated'
export type NoteSortDirection = 'asc' | 'desc'

export interface NoteSort {
  key: NoteSortKey
  direction: NoteSortDirection
}

export const NOTE_SORTS: readonly NoteSort[] = [
  { key: 'title', direction: 'asc' },
  { key: 'title', direction: 'desc' },
  { key: 'updated', direction: 'desc' },
  { key: 'updated', direction: 'asc' },
  { key: 'created', direction: 'desc' },
  { key: 'created', direction: 'asc' },
]

export const DEFAULT_NOTE_SORT: NoteSort = { key: 'updated', direction: 'desc' }

export type NoteSortId = `${NoteSortKey}-${NoteSortDirection}`

export function noteSortId(sort: NoteSort): NoteSortId {
  return `${sort.key}-${sort.direction}`
}

/** Undefined for anything that is not a known order. */
export function parseNoteSort(value: unknown): NoteSort | undefined {
  return NOTE_SORTS.find((sort) => noteSortId(sort) === value)
}

const collators = new Map<string, Intl.Collator>()

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

export type SortableNote = Pick<NoteSummary, 'id' | 'title' | 'createdAt' | 'updatedAt'>

/** The core's name order: numbers by value, case and accents aside, in `locales`. */
export function compareNames(
  a: string,
  b: string,
  locales: string | readonly string[] = [],
): number {
  return collator(locales).compare(a, b)
}

/** Equal titles put the newest updated first, and untitled notes come last either way. Equal dates fall back to the ID (UUIDv7, so creation order) in the same direction. */
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
