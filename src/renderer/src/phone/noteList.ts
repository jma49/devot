import type { BookRecord, NoteSummary } from '../../../core/storage'
import type { PhoneStatusFilter, PhoneView } from './library'

const newestFirst = (a: NoteSummary, b: NoteSummary) =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Pinned notes first, then the rest; newest first in each, so a new note tops the unpinned ones. */
export function orderNotes(notes: readonly NoteSummary[]): NoteSummary[] {
  const pinned = notes.filter((n) => n.pinned).sort(newestFirst)
  const rest = notes.filter((n) => !n.pinned).sort(newestFirst)
  return [...pinned, ...rest]
}

export type NoteSectionKey = 'pinned' | 'recent' | 'completed'

export interface NoteSection {
  readonly key: NoteSectionKey
  readonly notes: readonly NoteSummary[]
}

/** The list's sections, newest first in each, leaving out an empty one. */
export function noteSections(notes: readonly NoteSummary[]): NoteSection[] {
  const ordered = [...notes].sort(newestFirst)
  const sections: NoteSection[] = [
    { key: 'pinned', notes: ordered.filter((n) => n.pinned) },
    {
      key: 'recent',
      notes: ordered.filter((n) => !n.pinned && n.status !== 'completed'),
    },
    {
      key: 'completed',
      notes: ordered.filter((n) => !n.pinned && n.status === 'completed'),
    },
  ]
  return sections.filter((section) => section.notes.length > 0)
}

export type SectionChoices = Readonly<Partial<Record<NoteSectionKey, boolean>>>

/** Whether a section is collapsed: as chosen, else only Completed, unless that is what is filtered for. */
export const sectionCollapsed = (
  key: NoteSectionKey,
  chosen: SectionChoices,
  status: PhoneStatusFilter,
): boolean => chosen[key] ?? (key === 'completed' && status !== 'completed')

function withDescendants(id: string, books: readonly BookRecord[]): Set<string> {
  const found = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const book of books) {
      if (book.deletedAt === null && book.parentId !== null && found.has(book.parentId)) {
        if (!found.has(book.id)) {
          found.add(book.id)
          grew = true
        }
      }
    }
  }
  return found
}

/** The live notes a view lists; Templates and Trash are listed from their own sources. */
export function inView(
  notes: readonly NoteSummary[],
  view: PhoneView,
  books: readonly BookRecord[],
): NoteSummary[] {
  switch (view.kind) {
    case 'pinned':
      return notes.filter((n) => n.pinned)
    case 'book': {
      const ids = withDescendants(view.id, books)
      return notes.filter((n) => n.bookId !== null && ids.has(n.bookId))
    }
    case 'tag':
      return notes.filter((n) => n.tagIds.includes(view.id))
    default:
      return [...notes]
  }
}

export const withStatus = (
  notes: readonly NoteSummary[],
  status: PhoneStatusFilter,
): NoteSummary[] => (status === 'all' ? [...notes] : notes.filter((n) => n.status === status))

export function filterCounts(notes: readonly NoteSummary[]): Record<PhoneStatusFilter, number> {
  return {
    all: notes.length,
    active: withStatus(notes, 'active').length,
    on_hold: withStatus(notes, 'on_hold').length,
    completed: withStatus(notes, 'completed').length,
  }
}

export const PHONE_FILTERS: readonly PhoneStatusFilter[] = ['all', 'active', 'on_hold', 'completed']
