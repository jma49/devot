import type { BookRecord, NoteSummary, TagColor, TagRecord } from '../../../core/storage'
import { compareKeys } from '../../../core/order'
import { compareNames } from '../../../core/sort'

export type PhoneView =
  | { readonly kind: 'all' }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'book'; readonly id: string }
  | { readonly kind: 'tag'; readonly id: string }
  | { readonly kind: 'templates' }
  | { readonly kind: 'trash' }

export type PhoneStatusFilter = 'all' | 'active' | 'on_hold' | 'completed'

export interface LibraryCounts {
  readonly all: number
  readonly pinned: number
  readonly active: number
  readonly completed: number
}

export interface LibraryBookRow {
  readonly id: string
  readonly name: string
  readonly icon: string | null
  readonly color: TagColor | null
  readonly depth: number
  readonly count: number
  readonly hasChildren: boolean
  readonly open: boolean
}

export interface LibraryTagRow {
  readonly id: string
  readonly name: string
  readonly color: TagColor | null
  readonly count: number
}

export interface Library {
  readonly counts: LibraryCounts
  readonly books: readonly LibraryBookRow[]
  readonly tags: readonly LibraryTagRow[]
}

const bySortKey = (a: BookRecord, b: BookRecord) =>
  compareKeys(a.sortKey, b.sortKey) || compareKeys(a.id, b.id)

/** What the Library shows: live notes only, a notebook counting its own notes and its descendants'. */
export function libraryOf(
  notes: readonly NoteSummary[],
  books: readonly BookRecord[],
  tags: readonly TagRecord[],
  open: ReadonlySet<string>,
  locales: readonly string[] = [],
): Library {
  const live = books.filter((b) => b.deletedAt === null)
  const known = new Set(live.map((b) => b.id))
  const children = new Map<string | null, BookRecord[]>()
  for (const book of live) {
    const parent = book.parentId !== null && known.has(book.parentId) ? book.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), book])
  }
  const direct = new Map<string, number>()
  for (const note of notes) {
    if (note.bookId !== null) direct.set(note.bookId, (direct.get(note.bookId) ?? 0) + 1)
  }
  const total = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    return (children.get(id) ?? []).reduce(
      (sum, child) => sum + total(child.id, seen),
      direct.get(id) ?? 0,
    )
  }

  const rows: LibraryBookRow[] = []
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    for (const book of [...(children.get(parent) ?? [])].sort(bySortKey)) {
      if (seen.has(book.id)) continue
      seen.add(book.id)
      const hasChildren = (children.get(book.id) ?? []).length > 0
      const isOpen = hasChildren && open.has(book.id)
      rows.push({
        id: book.id,
        name: book.name,
        icon: book.icon,
        color: book.iconColor,
        depth,
        count: total(book.id, new Set()),
        hasChildren,
        open: isOpen,
      })
      if (isOpen) walk(book.id, depth + 1, seen)
    }
  }
  walk(null, 0, new Set())

  const perTag = new Map<string, number>()
  for (const note of notes)
    for (const id of new Set(note.tagIds)) perTag.set(id, (perTag.get(id) ?? 0) + 1)

  return {
    counts: {
      all: notes.length,
      pinned: notes.filter((n) => n.pinned).length,
      active: notes.filter((n) => n.status === 'active').length,
      completed: notes.filter((n) => n.status === 'completed').length,
    },
    books: rows,
    tags: tags
      .filter((tag) => tag.deletedAt === null)
      .sort((a, b) => compareNames(a.name, b.name, locales))
      .map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        count: perTag.get(tag.id) ?? 0,
      })),
  }
}

/** A notebook's path from the top, as the note's breadcrumb shows it; empty when it has none. */
export function notebookPath(
  books: readonly { id: string; name: string; parentId: string | null }[],
  id: string | null,
): string {
  const names: string[] = []
  const seen = new Set<string>()
  let at = id
  while (at !== null && !seen.has(at)) {
    seen.add(at)
    const book = books.find((b) => b.id === at)
    if (!book) break
    names.unshift(book.name)
    at = book.parentId
  }
  return names.join(' / ')
}
