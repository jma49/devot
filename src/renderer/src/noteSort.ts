// The note list's order. It is a view preference, so it lives in the
// webview's local storage, not in the note database, and never syncs. Each
// library view (All Notes, a notebook, a filter) remembers its own order;
// views without one follow a default the user can set from any view. Search
// results keep their relevance order unless the user picks another.
import { useCallback, useMemo, useState } from 'react'
import {
  DEFAULT_NOTE_SORT,
  NOTE_SORTS,
  noteSortId,
  parseNoteSort,
  sortNotes,
  type NoteSort,
  type NoteSortId,
  type SortableNote,
} from '../../core/sort'
import type { NoteFilter } from '../../core/tags'
import { useContextMenu, type MenuEntry, type MenuGroups } from './contextMenu'
import { t } from './i18n'

/** A list order: one of the six, or search relevance (search results only). */
export type ListOrder = NoteSort | 'relevance'

/** The view the search results belong to. */
const SEARCH = 'search'

/** The name a view's order is kept under. A filter is keyed by itself alone. */
export function sortView(options: {
  search: boolean
  bookId: string | null
  filter: NoteFilter | null
}): string {
  const { filter } = options
  if (options.search) return SEARCH
  if (filter?.kind === 'pinned') return 'filter:pinned'
  if (filter?.kind === 'status') return `filter:status:${filter.status}`
  if (filter?.kind === 'tag') return `filter:tag:${filter.tagId}`
  return options.bookId === null ? 'all' : `book:${options.bookId}`
}

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ViewOrder {
  order: ListOrder
  /** The view has no order of its own and shows the default. */
  followsDefault: boolean
}

const DEFAULT_KEY = 'devot.sort.default'
const viewKey = (view: string) => `devot.sort.view.${view}`

/** Reads and writes list orders; storage failures fall back to the defaults. */
export function sortStore(storage: KeyValue | undefined) {
  const read = (key: string) => {
    try {
      return storage?.getItem(key) ?? null
    } catch {
      return null
    }
  }
  const write = (key: string, value: string | null) => {
    try {
      if (value === null) storage?.removeItem(key)
      else storage?.setItem(key, value)
    } catch {
      console.warn('W_SORT_SAVE_FAILED')
    }
  }
  const defaultOrder = () => parseNoteSort(read(DEFAULT_KEY)) ?? DEFAULT_NOTE_SORT
  const own = (view: string): ListOrder | undefined => {
    const value = read(viewKey(view))
    return view === SEARCH && value === 'relevance' ? 'relevance' : parseNoteSort(value)
  }

  const load = (view: string): ViewOrder => {
    const order = own(view)
    if (order) return { order, followsDefault: false }
    if (view === SEARCH) return { order: 'relevance', followsDefault: false }
    return { order: defaultOrder(), followsDefault: true }
  }

  return {
    load,
    /** Gives the view its own order; picking the order it shows changes nothing. */
    choose(view: string, order: ListOrder) {
      if (order === 'relevance') {
        if (view === SEARCH) write(viewKey(view), null)
        return
      }
      const current = load(view)
      if (current.followsDefault && sameOrder(current.order, order)) return
      write(viewKey(view), noteSortId(order))
    },
    /** Makes the view's order the default; the view then follows the default. */
    makeDefault(view: string) {
      const { order } = load(view)
      if (view === SEARCH || order === 'relevance') return
      write(DEFAULT_KEY, noteSortId(order))
      write(viewKey(view), null)
    },
  }
}

const sameOrder = (a: ListOrder, b: ListOrder) =>
  a === b || (a !== 'relevance' && b !== 'relevance' && noteSortId(a) === noteSortId(b))

/** The store in this webview's local storage, shared by its windows. */
export function currentSortStore() {
  let storage: KeyValue | undefined
  try {
    storage = (globalThis as { localStorage?: KeyValue }).localStorage
  } catch {
    storage = undefined
  }
  return sortStore(storage)
}

/** Titles collate in the user's preferred languages, then the UI locale. */
export function sortLocales(preferred: readonly string[], uiLocale: string): string[] {
  return [...preferred, uiLocale]
}

// The sort pop-up: a native menu with the orders as check items.

export type SortAction = 'relevance' | 'default' | NoteSortId

/** What the menu needs to know about the list it sorts. */
export interface SortMenuTarget extends ViewOrder {
  search: boolean
}

const orderEntry = (order: NoteSort): MenuEntry<SortAction, SortMenuTarget> => {
  const id = noteSortId(order)
  return {
    action: id,
    label: `sort.${id}` as const,
    checked: (target) => sameOrder(target.order, order),
  }
}

/** Relevance (search only), the six orders in pairs, then Use as Default. */
export const SORT_MENU: MenuGroups<SortAction, SortMenuTarget> = [
  [
    {
      action: 'relevance',
      label: 'sort.relevance',
      shown: (target) => target.search,
      checked: (target) => target.order === 'relevance',
    },
  ],
  ...[0, 2, 4].map((i) => NOTE_SORTS.slice(i, i + 2).map(orderEntry)),
  [
    {
      action: 'default',
      label: 'sort.useAsDefault',
      shown: (target) => !target.search,
      checked: (target) => target.followsDefault,
    },
  ],
]

/** The order a menu item picks; undefined for Use as Default. */
export function sortAction(action: SortAction): ListOrder | undefined {
  return action === 'relevance' ? 'relevance' : parseNoteSort(action)
}

/** The label of an order, as the menu shows it. */
export function orderLabel(order: ListOrder): string {
  return t(order === 'relevance' ? 'sort.relevance' : (`sort.${noteSortId(order)}` as const))
}

/**
 * The order of one view and its pop-up. `show(anchor)` opens the menu under
 * the anchor (the header button); a pick re-sorts the list and is remembered.
 */
export function useListOrder(view: string) {
  const store = useMemo(() => currentSortStore(), [])
  // Read on every render (two small reads); a pick re-renders.
  const current = store.load(view)
  const [, setPicks] = useState(0)

  const pick = useCallback(
    (action: SortAction, target: SortMenuTarget & { view: string }) => {
      const order = sortAction(action)
      if (order) store.choose(target.view, order)
      else store.makeDefault(target.view)
      setPicks((n) => n + 1)
    },
    [store],
  )
  const showMenu = useContextMenu('sort', SORT_MENU, pick)
  const show = useCallback(
    (anchor: HTMLElement) => {
      const box = anchor.getBoundingClientRect()
      return showMenu(
        { ...store.load(view), search: view === SEARCH, view },
        { x: box.left, y: box.bottom },
      )
    },
    [showMenu, store, view],
  )
  return { ...current, show }
}

/** The rows in `order`; relevance keeps them as they came. */
export function applyOrder<T extends SortableNote>(
  rows: readonly T[],
  order: ListOrder,
  locales: readonly string[],
): T[] {
  return order === 'relevance' ? [...rows] : sortNotes(rows, order, locales)
}
