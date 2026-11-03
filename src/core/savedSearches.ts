// Saved searches: the sidebar's rows under Status, each a name and a query in the search field's
// syntax (search.ts), kept as typed. A query is resolved when it runs, so one that names a
// notebook or tag since deleted matches nothing and stays. The rows are ordered by hand with sort
// keys (order.ts), like notebooks. Synced as records of their own kind (sync/records.ts).

import { TEMPLATES_BOOK_ID, slotKeys } from './books'
import { receiveStored, type Clock } from './hlc'
import { compareKeys, keyBetween } from './order'
import { excludeTemplates, parseSearch, resolveSearch, type SearchScope } from './search'
import type {
  BookRecord,
  NoteQuery,
  NoteSummary,
  SavedSearchRecord,
  StorageAdapter,
  TagRecord,
} from './storage'
import { charCount, trimWhitespace, wellFormed } from './text'

export const MAX_SAVED_SEARCH_NAME_CHARS = 100
export const MAX_SAVED_SEARCH_QUERY_CHARS = 1000

export interface SavedSearchServiceOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
}

export interface SavedSearchService {
  /** In the order shown. */
  list(): Promise<SavedSearchRecord[]>
  /** Appends the row; answers its ID. */
  create(name: string, query: string): Promise<string>
  rename(id: string, name: string): Promise<void>
  setQuery(id: string, query: string): Promise<void>
  place(id: string, targetId: string, where: 'before' | 'after'): Promise<void>
  remove(id: string): Promise<void>
}

const oneLine = (text: string, max: number, code: string): string => {
  const trimmed = trimWhitespace(wellFormed(text))
  if (!trimmed || /[\r\n]/.test(trimmed) || charCount(trimmed) > max) throw new Error(code)
  return trimmed
}

export const cleanSavedSearchName = (name: string): string =>
  oneLine(name, MAX_SAVED_SEARCH_NAME_CHARS, 'E_SAVED_SEARCH_NAME_INVALID')

export const cleanSavedSearchQuery = (query: string): string =>
  oneLine(query, MAX_SAVED_SEARCH_QUERY_CHARS, 'E_SAVED_SEARCH_QUERY_INVALID')

/** Key order, then ID order: what storage lists, kept the same on every reader. */
export const savedSearchOrder = (a: SavedSearchRecord, b: SavedSearchRecord): number =>
  compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id)

const stamps = (s: SavedSearchRecord) => [s.nameHlc, s.queryHlc, s.sortKeyHlc, s.deletedHlc]

export function createSavedSearchService(options: SavedSearchServiceOptions): SavedSearchService {
  const { storage, clock, newId } = options
  const now = options.now ?? Date.now

  /** Their stamps are taken in by the clock, so a write based on them always wins (see receiveStored). */
  const listAll = async () => {
    const all = (await storage.listSavedSearches()).sort(savedSearchOrder)
    receiveStored(clock, all.flatMap(stamps))
    return all
  }
  const find = async (id: string) => {
    const search = (await listAll()).find((s) => s.id === id)
    if (!search) throw new Error('E_SAVED_SEARCH_NOT_FOUND')
    return search
  }
  const write = (search: SavedSearchRecord) =>
    storage.putSavedSearch({ ...search, updatedAt: Math.max(now(), search.createdAt) })

  return {
    list: async () => (await storage.listSavedSearches()).sort(savedSearchOrder),

    async create(name, query) {
      const cleanName = cleanSavedSearchName(name)
      const cleanQuery = cleanSavedSearchQuery(query)
      const all = await listAll()
      const last = all.at(-1)
      const at = now()
      const id = newId()
      await storage.putSavedSearch({
        id,
        name: cleanName,
        nameHlc: clock.tick(),
        query: cleanQuery,
        queryHlc: clock.tick(),
        sortKey: keyBetween(last && last.sortKey !== '' ? last.sortKey : null, null),
        sortKeyHlc: clock.tick(),
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        deletedHlc: null,
      })
      return id
    },

    async rename(id, name) {
      const clean = cleanSavedSearchName(name)
      const search = await find(id)
      if (clean === search.name) return
      await write({ ...search, name: clean, nameHlc: clock.tick() })
    },

    async setQuery(id, query) {
      const clean = cleanSavedSearchQuery(query)
      const search = await find(id)
      if (clean === search.query) return
      await write({ ...search, query: clean, queryHlc: clock.tick() })
    },

    async place(id, targetId, where) {
      if (id === targetId) return
      const all = await listAll()
      const search = all.find((s) => s.id === id)
      if (!search || !all.some((s) => s.id === targetId)) {
        throw new Error('E_SAVED_SEARCH_NOT_FOUND')
      }
      const siblings = all.filter((s) => s.id !== id)
      const index = siblings.findIndex((s) => s.id === targetId) + (where === 'after' ? 1 : 0)
      const { key, others } = slotKeys(siblings, index)
      for (const sibling of siblings) {
        const next = others.get(sibling.id)
        if (next !== undefined) await write({ ...sibling, sortKey: next, sortKeyHlc: clock.tick() })
      }
      await write({ ...search, sortKey: key, sortKeyHlc: clock.tick() })
    },

    async remove(id) {
      const search = await find(id)
      await write({ ...search, deletedAt: now(), deletedHlc: clock.tick() })
    },
  }
}

export interface SavedSearchContext {
  books: readonly BookRecord[]
  tags: readonly TagRecord[]
  /** The workspace open, which every saved search keeps to while it is. */
  scope?: SearchScope | undefined
}

/**
 * The query a saved search runs now, resolved against the notebooks and tags
 * as they are (as NoteService.search resolves one); null when it can match
 * nothing, such as a name nothing has any more.
 */
export function savedSearchQuery(
  search: Pick<SavedSearchRecord, 'query'>,
  context: SavedSearchContext,
): NoteQuery | null {
  const clauses = parseSearch(search.query)
  if (clauses.length === 0) return null
  const nameable = context.books.filter((b) => b.id !== TEMPLATES_BOOK_ID)
  const resolved = resolveSearch(clauses, {
    books: context.books,
    tags: context.tags,
    scope: context.scope,
    nameable,
  })
  return resolved ? excludeTemplates(resolved) : null
}

/** Whether a listed note meets the query's conditions on its fields; its text is not at hand. */
export function meetsConditions(note: NoteSummary, query: NoteQuery): boolean {
  if (query.pinned !== null && query.pinned !== note.pinned) return false
  return query.sets.every((set) => {
    const values =
      set.kind === 'book' ? [note.bookId] : set.kind === 'tag' ? note.tagIds : [note.status]
    return values.some((v) => v !== null && set.ids.includes(v)) !== set.negate
  })
}

/**
 * How many of the listed notes a query matches, from their fields alone: null
 * when the query has text, which only storage can look for (the count then
 * comes from running the search).
 */
export function countMatches(
  notes: readonly NoteSummary[],
  query: NoteQuery | null,
): number | null {
  if (query === null) return 0
  if (query.text.length > 0) return null
  let count = 0
  for (const note of notes) if (meetsConditions(note, query)) count += 1
  return count
}
