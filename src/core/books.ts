// Notebooks ("books"): nestable folders for notes. Each field is last-writer-wins by HLC. Deleting a notebook deletes its sub-notebooks; their notes stay and count
// as in no notebook. Siblings are ordered by a sort key (order.ts), ties broken by ID, so every device shows the same order. Notebooks from before sort keys
// (schema v10) have none until the core keys them (`settleOrder`); until then they show by name.

import { receiveStored, type Clock } from './hlc'
import { compareKeys, isSortKey, keyBetween, MAX_SORT_KEY_LENGTH, sequentialKeys } from './order'
import { isNotebookIcon } from './notebookIcons'
import {
  MAX_PUT_BOOKS,
  TAG_COLORS,
  type BookRecord,
  type NoteSummary,
  type StorageAdapter,
  type TagColor,
} from './storage'
import { TEMPLATES_BOOK_ID } from './templatesBook'
import { charCount, trimWhitespace, wellFormed } from './text'

export const MAX_BOOK_NAME_CHARS = 200

export { TEMPLATES_BOOK_ID }

export interface BookServiceOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
  locale?: string
}

export interface BookService {
  /** Not deleted, and never Templates (TEMPLATES_BOOK_ID). */
  list(): Promise<BookRecord[]>
  /** After the others in `parentId` (null: top level), with Allow AI Access off unless `aiAccess`. */
  create(name: string, parentId: string | null, options?: { aiAccess?: boolean }): Promise<string>
  /** As `create` for each in turn (the same names, keys, parents and clocks), in one write; nothing is written when a name or a parent is refused. Answers their IDs in order. */
  createMany(drafts: readonly BookDraft[]): Promise<string[]>
  rename(id: string, name: string): Promise<void>
  /** Under `parentId` (null: top level), after the others there. */
  move(id: string, parentId: string | null): Promise<void>
  /** Right before or after `targetId`, under the same parent; writes only the moved notebook unless its neighbours share a key. */
  place(id: string, targetId: string, where: 'before' | 'after'): Promise<void>
  /** Also deletes the sub-notebooks; the notes are kept. */
  remove(id: string): Promise<void>
  /** As `remove` for each, in one write. */
  removeMany(ids: readonly string[]): Promise<void>
  /** For this notebook alone. */
  setAiAccess(id: string, on: boolean): Promise<void>
  /** Throws E_BOOK_ICON_INVALID for an unknown icon or colour. */
  setIcon(id: string, icon: string | null, color: TagColor | null): Promise<void>
  /** Keeps the order the notebooks show in (by name in the locale's collation, ahead of keyed siblings). The keys get no clock, so any later move wins; where two devices keyed a notebook differently the greater key wins on both. Run once when the core starts. */
  settleOrder(): Promise<void>
}

/** A notebook for `createMany`: under `parentId` (null: top level), or under the one made for the earlier draft at `parentIndex`. */
export interface BookDraft {
  name: string
  parentId: string | null
  parentIndex?: number
  aiAccess?: boolean
}

export interface BookNode {
  id: string
  name: string
  parentId: string | null
  depth: number
  aiAccess: boolean
  icon: string | null
  iconColor: TagColor | null
  children: BookNode[]
}

export function bookIcon(book: Pick<BookRecord, 'icon' | 'iconColor'>): {
  icon: string | null
  iconColor: TagColor | null
} {
  return {
    icon: isNotebookIcon(book.icon) ? book.icon : null,
    iconColor:
      book.iconColor !== null && TAG_COLORS.includes(book.iconColor) ? book.iconColor : null,
  }
}

function cleanName(name: string): string {
  const trimmed = trimWhitespace(wellFormed(name))
  if (!trimmed || trimmed.includes('\n') || charCount(trimmed) > MAX_BOOK_NAME_CHARS) {
    throw new Error('E_BOOK_NAME_INVALID')
  }
  return trimmed
}

/** A missing parent (deleted, or not synced yet) makes a notebook top level; a parent cycle (after concurrent moves) is broken at its smallest ID, the same on every device. */
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

const nameOrder =
  (locale?: string) =>
  (a: Pick<BookRecord, 'name'>, b: Pick<BookRecord, 'name'>): number =>
    a.name.localeCompare(b.name, locale, { sensitivity: 'base' })

const unkeyed = (book: Pick<BookRecord, 'sortKey' | 'sortKeyHlc'>) =>
  book.sortKey === '' && book.sortKeyHlc === ''

type Ordered = Pick<BookRecord, 'id' | 'name' | 'sortKey' | 'sortKeyHlc'>

export const bookOrder = (a: Ordered, b: Ordered, locale?: string): number =>
  compareKeys(a.sortKey, b.sortKey) ||
  Number(unkeyed(b)) - Number(unkeyed(a)) ||
  (unkeyed(a) ? nameOrder(locale)(a, b) : 0) ||
  compareKeys(a.id, b.id)

export function buildBookTree(books: readonly BookRecord[]): BookNode[] {
  const parents = effectiveParents(books)
  const ordered = [...books].sort((a, b) => bookOrder(a, b))
  const nodes = new Map<string, BookNode>(
    books.map((b) => [
      b.id,
      {
        id: b.id,
        name: b.name,
        parentId: null,
        depth: 0,
        aiAccess: b.aiAccess,
        ...bookIcon(b),
        children: [],
      },
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

export function flattenBookTree(nodes: readonly BookNode[]): BookNode[] {
  return nodes.flatMap((n) => [n, ...flattenBookTree(n.children)])
}

export interface MoveTarget {
  id: string
  name: string
  depth: number
  icon: string | null
  iconColor: TagColor | null
  disabled: boolean
}

export function moveTargets(tree: readonly BookNode[], movingId: string): MoveTarget[] {
  const out: MoveTarget[] = []
  const walk = (nodes: readonly BookNode[], disabled: boolean) => {
    for (const node of nodes) {
      const off = disabled || node.id === movingId
      out.push({
        id: node.id,
        name: node.name,
        depth: node.depth,
        icon: node.icon,
        iconColor: node.iconColor,
        disabled: off,
      })
      walk(node.children, off)
    }
  }
  walk(tree, false)
  return out
}

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

const bookStamps = (b: BookRecord) => [
  b.nameHlc,
  b.parentHlc,
  b.deletedHlc,
  b.aiAccessHlc,
  b.sortKeyHlc,
  b.iconHlc,
]

function findIn(books: readonly BookRecord[], id: string): BookRecord {
  const book = books.find((b) => b.id === id)
  if (!book) throw new Error('E_BOOK_NOT_FOUND')
  return book
}

export function createBookService(options: BookServiceOptions): BookService {
  const { storage, clock, newId } = options
  const now = options.now ?? Date.now

  /** Their stamps are taken in by the clock, so a write based on them always wins (see receiveStored). */
  const listBooks = async () => {
    const all = await storage.listBooks()
    receiveStored(clock, all.flatMap(bookStamps))
    return all.filter((b) => b.id !== TEMPLATES_BOOK_ID)
  }

  const find = async (id: string): Promise<BookRecord> => findIn(await listBooks(), id)

  const write = (book: BookRecord) =>
    storage.putBook({ ...book, updatedAt: Math.max(now(), book.createdAt) })

  const siblingsOf = (books: readonly BookRecord[], parentId: string | null, except?: string) => {
    const parents = effectiveParents(books)
    return books
      .filter((b) => b.id !== except && (parents.get(b.id) ?? null) === parentId)
      .sort((a, b) => bookOrder(a, b, options.locale))
  }

  /** Writes new keys for the siblings only when there is no room between the neighbours. */
  const slot = async (siblings: readonly BookRecord[], index: number): Promise<string> => {
    const { key, others } = slotKeys(siblings, index)
    for (const sibling of siblings) {
      const next = others.get(sibling.id)
      if (next !== undefined) await write({ ...sibling, sortKey: next, sortKeyHlc: clock.tick() })
    }
    return key
  }

  /**
   * What `create` writes for each draft in turn, from `books` as listed: the siblings rekeyed
   * where there is no room after the last, then the notebook. The siblings of each parent are
   * found once, so a batch costs time linear in the notebooks.
   */
  const plan = (books: readonly BookRecord[], drafts: readonly BookDraft[]) => {
    const byId = new Map(books.map((b) => [b.id, b]))
    const parents = effectiveParents(books)
    const children = new Map<string | null, BookRecord[]>()
    for (const book of books) {
      const parent = parents.get(book.id) ?? null
      const list = children.get(parent)
      if (list) list.push(book)
      else children.set(parent, [book])
    }
    const sorted = new Set<string | null>()
    const childrenOf = (parentId: string | null) => {
      const list = children.get(parentId) ?? []
      if (!sorted.has(parentId)) {
        list.sort((a, b) => bookOrder(a, b, options.locale))
        children.set(parentId, list)
        sorted.add(parentId)
      }
      return list
    }
    const ids: string[] = []
    const writes: BookRecord[] = []
    for (const [index, { parentIndex: under, parentId }] of drafts.entries()) {
      const found =
        under === undefined
          ? parentId === null || byId.has(parentId)
          : Number.isInteger(under) && under >= 0 && under < index
      if (!found) throw new Error('E_BOOK_NOT_FOUND')
    }
    let newest: string | null = null
    for (const draft of drafts) {
      // `create` lists the notebooks, so the clock takes in the newest stamp: the last one made.
      if (newest !== null) clock.receive(newest)
      const parentId = draft.parentIndex === undefined ? draft.parentId : ids[draft.parentIndex]!
      const siblings = childrenOf(parentId)
      const { key, others } = slotKeys(siblings, siblings.length)
      for (const [i, sibling] of siblings.entries()) {
        const next = others.get(sibling.id)
        if (next === undefined) continue
        const rekeyed = { ...sibling, sortKey: next, sortKeyHlc: clock.tick() }
        const written = { ...rekeyed, updatedAt: Math.max(now(), rekeyed.createdAt) }
        siblings[i] = written
        byId.set(written.id, written)
        writes.push(written)
      }
      const hlc = clock.tick()
      const at = now()
      const id = newId()
      const book: BookRecord = {
        id,
        name: draft.name,
        nameHlc: hlc,
        parentId,
        parentHlc: hlc,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        deletedHlc: null,
        aiAccess: draft.aiAccess === true,
        aiAccessHlc: draft.aiAccess === true ? hlc : '',
        sortKey: key,
        sortKeyHlc: hlc,
        icon: null,
        iconColor: null,
        iconHlc: '',
      }
      siblings.push(book)
      children.set(id, [])
      sorted.add(id)
      byId.set(id, book)
      ids.push(id)
      writes.push(book)
      newest = hlc
    }
    return { ids, writes }
  }

  /** The parent and its clock change only when the notebook shows under another parent: one shown at the top level because its parent is missing keeps that parent when only reordered. */
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

  const removeMany = async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) return
    const books = await listBooks()
    const known = new Set(books.map((b) => b.id))
    if (!ids.every((id) => known.has(id))) throw new Error('E_BOOK_NOT_FOUND')
    const parents = effectiveParents(books)
    const children = new Map<string, string[]>()
    for (const [child, parent] of parents) {
      if (parent === null) continue
      const list = children.get(parent)
      if (list) list.push(child)
      else children.set(parent, [child])
    }
    const doomed = new Set<string>()
    const visit = [...ids]
    for (let id = visit.pop(); id !== undefined; id = visit.pop()) {
      if (doomed.has(id)) continue
      doomed.add(id)
      visit.push(...(children.get(id) ?? []))
    }
    const at = now()
    const deleted = books
      .filter((b) => doomed.has(b.id))
      .map((b) => ({
        ...b,
        deletedAt: at,
        deletedHlc: clock.tick(),
        updatedAt: Math.max(at, b.createdAt),
      }))
    for (let i = 0; i < deleted.length; i += MAX_PUT_BOOKS) {
      await storage.putBooks(deleted.slice(i, i + MAX_PUT_BOOKS))
    }
  }

  return {
    list: listBooks,

    async create(name, parentId, extra) {
      const clean = cleanName(name)
      const books = await listBooks()
      const { ids, writes } = plan(books, [
        { name: clean, parentId, ...(extra?.aiAccess ? { aiAccess: true } : {}) },
      ])
      for (const book of writes) await storage.putBook(book)
      return ids[0]!
    },

    async createMany(drafts) {
      const clean = drafts.map((draft) => ({ ...draft, name: cleanName(draft.name) }))
      if (clean.length === 0) return []
      const { ids, writes } = plan(await listBooks(), clean)
      const latest = [...new Map(writes.map((book) => [book.id, book])).values()]
      for (let i = 0; i < latest.length; i += MAX_PUT_BOOKS) {
        await storage.putBooks(latest.slice(i, i + MAX_PUT_BOOKS))
      }
      return ids
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

    remove: (id) => removeMany([id]),

    removeMany,

    async setAiAccess(id, on) {
      const book = await find(id)
      await write({ ...book, aiAccess: on, aiAccessHlc: clock.tick() })
    },

    async setIcon(id, icon, color) {
      if (
        (icon !== null && !isNotebookIcon(icon)) ||
        (color !== null && !TAG_COLORS.includes(color)) ||
        (icon === null && color !== null)
      ) {
        throw new Error('E_BOOK_ICON_INVALID')
      }
      const book = await find(id)
      await write({ ...book, icon, iconColor: color, iconHlc: clock.tick() })
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
