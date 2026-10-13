// Notebooks ("books"): nestable folders for notes. Each field (name, parent,
// place among siblings, deletion) is last-writer-wins by HLC. Deleting a
// notebook deletes its sub-notebooks too; their notes stay and count as in
// no notebook. Siblings are in the user's order: a sort key per notebook
// (order.ts), ties broken by ID, so every device shows the same order.
// Notebooks from before sort keys (schema v10) have none until the core
// keys them (`settleOrder`); until then they show as before, by name.

import { receiveStored, type Clock } from './hlc'
import { compareKeys, isSortKey, keyBetween, MAX_SORT_KEY_LENGTH, sequentialKeys } from './order'
import type { BookRecord, NoteSummary, StorageAdapter } from './storage'
import { charCount, trimWhitespace } from './text'

export const MAX_BOOK_NAME_CHARS = 200

/**
 * The reserved notebook that holds note templates (see templates.ts). Every
 * device knows it by this ID, so the copies two devices make of it merge
 * into one row. It is UUIDv7-shaped (version 7, variant 10) with a zero
 * timestamp, which no generated ID has. It is not one of the user's
 * notebooks: the notebook service never lists or changes it.
 */
export const TEMPLATES_BOOK_ID = '00000000-0000-7000-8000-000000000001'

export interface BookServiceOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
  /** The collation locale for names; the runtime's default when left out. */
  locale?: string
}

export interface BookService {
  /** Notebooks that are not deleted (never Templates, see TEMPLATES_BOOK_ID). */
  list(): Promise<BookRecord[]>
  /** Creates a notebook after the others in `parentId` (null: top level). */
  create(name: string, parentId: string | null): Promise<string>
  rename(id: string, name: string): Promise<void>
  /** Moves a notebook under `parentId` (null: top level), after the others there. */
  move(id: string, parentId: string | null): Promise<void>
  /**
   * Puts a notebook right before or after `targetId`, under the same parent.
   * Writes only the moved notebook, unless its neighbours share one key.
   */
  place(id: string, targetId: string, where: 'before' | 'after'): Promise<void>
  /** Deletes a notebook and its sub-notebooks. Notes are kept. */
  remove(id: string): Promise<void>
  /** Turns Allow AI Access on or off for this notebook alone. */
  setAiAccess(id: string, on: boolean): Promise<void>
  /**
   * Gives every notebook without a sort key (from before schema v10) one,
   * keeping the order it shows in: by name in the locale's collation, as
   * the sidebar sorted before, ahead of any keyed siblings. The keys get no
   * clock, so any later move wins, and where two devices keyed a notebook
   * differently the greater key wins on both. Run once when the core starts.
   */
  settleOrder(): Promise<void>
}

export interface BookNode {
  id: string
  name: string
  parentId: string | null
  depth: number
  aiAccess: boolean
  children: BookNode[]
}

/** A notebook name trimmed as Rust trims it (src-tauri/src/commands/books.rs checks the same). */
function cleanName(name: string): string {
  const trimmed = trimWhitespace(name)
  if (!trimmed || trimmed.includes('\n') || charCount(trimmed) > MAX_BOOK_NAME_CHARS) {
    throw new Error('E_BOOK_NAME_INVALID')
  }
  return trimmed
}

/**
 * The effective parent of every notebook. A parent that is missing (deleted,
 * or not synced yet) makes a notebook top level; a parent cycle (possible
 * after concurrent moves on two devices) is broken at its smallest ID, the
 * same way on every device.
 */
function effectiveParents(books: readonly BookRecord[]): Map<string, string | null> {
  const byId = new Map(books.map((b) => [b.id, b]))
  const parents = new Map<string, string | null>()
  for (const book of books) {
    parents.set(book.id, book.parentId !== null && byId.has(book.parentId) ? book.parentId : null)
  }
  for (const book of books) {
    const path: string[] = []
    let at: string | null = book.id
    while (at !== null && !path.includes(at)) {
      path.push(at)
      at = parents.get(at) ?? null
    }
    if (at !== null) {
      const cycle = path.slice(path.indexOf(at))
      const root = [...cycle].sort()[0]!
      parents.set(root, null)
    }
  }
  return parents
}

/** The order notebooks had before sort keys: by name in the locale's collation. */
const nameOrder =
  (locale?: string) =>
  (a: Pick<BookRecord, 'name'>, b: Pick<BookRecord, 'name'>): number =>
    a.name.localeCompare(b.name, locale, { sensitivity: 'base' })

/** Whether a notebook is from before sort keys and not keyed yet. */
const unkeyed = (book: Pick<BookRecord, 'sortKey' | 'sortKeyHlc'>) =>
  book.sortKey === '' && book.sortKeyHlc === ''

type Ordered = Pick<BookRecord, 'id' | 'name' | 'sortKey' | 'sortKeyHlc'>

/**
 * Sibling order: by sort key, then by ID (equal keys come from concurrent
 * moves). Unkeyed notebooks (empty keys) come first, by name as before.
 */
export const bookOrder = (a: Ordered, b: Ordered, locale?: string): number =>
  compareKeys(a.sortKey, b.sortKey) ||
  Number(unkeyed(b)) - Number(unkeyed(a)) ||
  (unkeyed(a) ? nameOrder(locale)(a, b) : 0) ||
  compareKeys(a.id, b.id)

/** Top-level notebooks with their children, each level in the user's order. */
export function buildBookTree(books: readonly BookRecord[]): BookNode[] {
  const parents = effectiveParents(books)
  // Visited in sibling order, so every list fills up in order.
  const ordered = [...books].sort((a, b) => bookOrder(a, b))
  const nodes = new Map<string, BookNode>(
    books.map((b) => [
      b.id,
      { id: b.id, name: b.name, parentId: null, depth: 0, aiAccess: b.aiAccess, children: [] },
    ]),
  )
  const roots: BookNode[] = []
  for (const book of ordered) {
    const node = nodes.get(book.id)!
    const parentId = parents.get(book.id) ?? null
    node.parentId = parentId
    if (parentId === null) roots.push(node)
    else nodes.get(parentId)!.children.push(node)
  }
  const settle = (list: BookNode[], depth: number) => {
    for (const node of list) {
      node.depth = depth
      settle(node.children, depth + 1)
    }
  }
  settle(roots, 0)
  return roots
}

/** Every notebook in tree order: each one followed by its sub-notebooks. */
export function flattenBookTree(nodes: readonly BookNode[]): BookNode[] {
  return nodes.flatMap((n) => [n, ...flattenBookTree(n.children)])
}

/**
 * The sort key that puts a notebook at `index` among `siblings` (sorted,
 * without it), and new keys for siblings when there is no room: their keys
 * are equal there, malformed, or the new key would be too long. Then the
 * whole list gets fresh keys, and only the siblings whose key changes are
 * returned.
 */
export function slotKeys(
  siblings: readonly Pick<BookRecord, 'id' | 'sortKey'>[],
  index: number,
): { key: string; others: Map<string, string> } {
  const low = index > 0 ? siblings[index - 1]!.sortKey : null
  const high = index < siblings.length ? siblings[index]!.sortKey : null
  const fits =
    (low === null || isSortKey(low)) &&
    (high === null || isSortKey(high)) &&
    (low === null || high === null || low < high)
  if (fits) {
    const key = keyBetween(low, high)
    if (key.length <= MAX_SORT_KEY_LENGTH) return { key, others: new Map() }
  }
  const keys = sequentialKeys(siblings.length + 1)
  const others = new Map<string, string>()
  siblings.forEach((sibling, i) => {
    const key = keys[i < index ? i : i + 1]!
    if (key !== sibling.sortKey) others.set(sibling.id, key)
  })
  return { key: keys[index]!, others }
}

/** A notebook's ID with the IDs of all its sub-notebooks. */
export function bookWithDescendants(books: readonly BookRecord[], id: string): Set<string> {
  const parents = effectiveParents(books)
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const [child, parent] of parents) {
      if (parent !== null && ids.has(parent) && !ids.has(child)) {
        ids.add(child)
        grew = true
      }
    }
  }
  return ids
}

/**
 * The notes in a notebook and its sub-notebooks; `null` gives the notes in
 * no (live) notebook.
 */
export function notesInBook<T extends Pick<NoteSummary, 'bookId'>>(
  notes: readonly T[],
  books: readonly BookRecord[],
  bookId: string | null,
): T[] {
  if (bookId === null) {
    const live = new Set(books.map((b) => b.id))
    return notes.filter((n) => n.bookId === null || !live.has(n.bookId))
  }
  const ids = bookWithDescendants(books, bookId)
  return notes.filter((n) => n.bookId !== null && ids.has(n.bookId))
}

/** Notes per notebook, each count including the notebook's sub-notebooks. */
export function bookCounts(
  notes: readonly Pick<NoteSummary, 'bookId'>[],
  books: readonly BookRecord[],
): Map<string, number> {
  const parents = effectiveParents(books)
  const counts = new Map<string, number>(books.map((b) => [b.id, 0]))
  for (const note of notes) {
    let at = note.bookId !== null && counts.has(note.bookId) ? note.bookId : null
    while (at !== null) {
      counts.set(at, (counts.get(at) ?? 0) + 1)
      at = parents.get(at) ?? null
    }
  }
  return counts
}

/** The HLCs of a notebook's fields. */
const bookStamps = (b: BookRecord) => [
  b.nameHlc,
  b.parentHlc,
  b.deletedHlc,
  b.aiAccessHlc,
  b.sortKeyHlc,
]

function findIn(books: readonly BookRecord[], id: string): BookRecord {
  const book = books.find((b) => b.id === id)
  if (!book) throw new Error('E_BOOK_NOT_FOUND')
  return book
}

export function createBookService(options: BookServiceOptions): BookService {
  const { storage, clock, newId } = options
  const now = options.now ?? Date.now

  /**
   * The user's notebooks that are not deleted: every one but Templates. Their
   * stamps are taken in by the clock, so a write based on them always wins
   * over them (see receiveStored).
   */
  const listBooks = async () => {
    const all = await storage.listBooks()
    receiveStored(clock, all.flatMap(bookStamps))
    return all.filter((b) => b.id !== TEMPLATES_BOOK_ID)
  }

  const find = async (id: string): Promise<BookRecord> => findIn(await listBooks(), id)

  const write = (book: BookRecord) =>
    storage.putBook({ ...book, updatedAt: Math.max(now(), book.createdAt) })

  /** Live notebooks under the effective parent `parentId`, in order, without `except`. */
  const siblingsOf = (books: readonly BookRecord[], parentId: string | null, except?: string) => {
    const parents = effectiveParents(books)
    return books
      .filter((b) => b.id !== except && (parents.get(b.id) ?? null) === parentId)
      .sort((a, b) => bookOrder(a, b, options.locale))
  }

  /**
   * The key for a notebook at `index` among `siblings`. Writes new keys for
   * the siblings only when there is no room between its neighbours.
   */
  const slot = async (siblings: readonly BookRecord[], index: number): Promise<string> => {
    const { key, others } = slotKeys(siblings, index)
    for (const sibling of siblings) {
      const next = others.get(sibling.id)
      if (next !== undefined) await write({ ...sibling, sortKey: next, sortKeyHlc: clock.tick() })
    }
    return key
  }

  /**
   * Writes `book` under the effective parent `parentId` at `index` among
   * `siblings` (one row, see `slot`). The parent and its clock change only
   * when the notebook shows under another parent: a notebook shown at the
   * top level because its parent is missing keeps that parent when it is
   * only reordered.
   */
  const putAt = async (
    books: readonly BookRecord[],
    book: BookRecord,
    parentId: string | null,
    siblings: readonly BookRecord[],
    index: number,
  ) => {
    const key = await slot(siblings, index)
    const moved = parentId !== (effectiveParents(books).get(book.id) ?? null)
    await write({
      ...book,
      ...(moved ? { parentId, parentHlc: clock.tick() } : {}),
      sortKey: key,
      sortKeyHlc: clock.tick(),
    })
  }

  return {
    list: listBooks,

    async create(name, parentId) {
      const clean = cleanName(name)
      const books = await listBooks()
      if (parentId !== null) findIn(books, parentId)
      const siblings = siblingsOf(books, parentId)
      const key = await slot(siblings, siblings.length)
      const hlc = clock.tick()
      const at = now()
      const id = newId()
      await storage.putBook({
        id,
        name: clean,
        nameHlc: hlc,
        parentId,
        parentHlc: hlc,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        deletedHlc: null,
        aiAccess: false,
        aiAccessHlc: '',
        sortKey: key,
        sortKeyHlc: hlc,
      })
      return id
    },

    async rename(id, name) {
      const clean = cleanName(name)
      const book = await find(id)
      await write({ ...book, name: clean, nameHlc: clock.tick() })
    },

    async move(id, parentId) {
      const books = await listBooks()
      const book = findIn(books, id)
      if (parentId !== null) {
        if (!books.some((b) => b.id === parentId)) throw new Error('E_BOOK_NOT_FOUND')
        if (bookWithDescendants(books, id).has(parentId)) throw new Error('E_BOOK_CYCLE')
      }
      const siblings = siblingsOf(books, parentId, id)
      await putAt(books, book, parentId, siblings, siblings.length)
    },

    async place(id, targetId, where) {
      const books = await listBooks()
      const book = findIn(books, id)
      findIn(books, targetId)
      if (targetId === id) return
      if (bookWithDescendants(books, id).has(targetId)) throw new Error('E_BOOK_CYCLE')
      const parentId = effectiveParents(books).get(targetId) ?? null
      const siblings = siblingsOf(books, parentId, id)
      const index = siblings.findIndex((b) => b.id === targetId) + (where === 'after' ? 1 : 0)
      await putAt(books, book, parentId, siblings, index)
    },

    async remove(id) {
      await find(id)
      const books = await listBooks()
      const doomed = bookWithDescendants(books, id)
      const at = now()
      for (const book of books.filter((b) => doomed.has(b.id))) {
        await write({ ...book, deletedAt: at, deletedHlc: clock.tick() })
      }
    },

    async setAiAccess(id, on) {
      const book = await find(id)
      await write({ ...book, aiAccess: on, aiAccessHlc: clock.tick() })
    },

    async settleOrder() {
      const books = await listBooks()
      const parents = effectiveParents(books)
      for (const parentId of new Set(parents.values())) {
        const siblings = siblingsOf(books, parentId)
        const waiting = siblings.filter(unkeyed)
        if (waiting.length === 0) continue
        // Counting down from the first keyed sibling, or up from the first key.
        const first = siblings.find((b) => isSortKey(b.sortKey))?.sortKey ?? null
        const keys = first === null ? sequentialKeys(waiting.length) : []
        while (keys.length < waiting.length) keys.unshift(keyBetween(null, keys[0] ?? first))
        // Not a change by the user: the clocks and the update time stay.
        for (const [i, book] of waiting.entries()) {
          await storage.putBook({ ...book, sortKey: keys[i]!, sortKeyHlc: '' })
        }
      }
    },
  }
}
