import { useMemo } from 'react'
import type { BookRecord, NoteSummary } from '../../../core'
import { noteOrder } from '../../../core/sort'
import { filterNotes, noteGroups, type NoteFilter } from '../../../core/tags'
import { changedInPlace, countsAlike, earlierList, movedInOrder } from '../listUpdates'
import { applyOrder, type ListOrder } from '../noteSort'
import { useKept } from '../stable'

/**
 * `notes`, or the list kept from an earlier render while the notes count
 * alike (`countsAlike`): a save changes a note's date and text, not its
 * counts, so the counts are not taken again. Read its notes' counted fields only.
 */
export function useCountedNotes(notes: NoteSummary[]): NoteSummary[] {
  return useKept(
    notes,
    (kept, next) =>
      changedInPlace(kept, next)?.every(([was, now]) => countsAlike(was, now)) ?? false,
  )
}

type Grouped = ReturnType<typeof noteGroups<NoteSummary>>
type View = readonly [
  books: readonly BookRecord[],
  bookId: string | null,
  by: NoteFilter | null,
  order: ListOrder,
  locales: readonly string[],
]

// The groups last made from each list, to move only the notes a save changed in the list made from it.
const grouped = new WeakMap<readonly NoteSummary[], { view: View; groups: Grouped }>()
const LINEAGE = 8

function earlierGroups(notes: NoteSummary[], view: View) {
  let list = earlierList(notes)
  for (let step = 0; list && step < LINEAGE; step += 1) {
    const found = grouped.get(list)
    if (found)
      return found.view.every((part, i) => part === view[i]) ? { list, ...found } : undefined
    list = earlierList(list)
  }
  return undefined
}

function groupsOf(notes: NoteSummary[], view: View): Grouped {
  const [books, bookId, by, order, locales] = view
  const was = earlierGroups(notes, view)
  const changed = was && changedInPlace(was.list, notes)
  if (!was || !changed?.every(([a, b]) => countsAlike(a, b))) {
    return noteGroups(applyOrder(filterNotes(notes, books, { bookId, by }), order, locales))
  }
  const compare = order === 'relevance' ? undefined : noteOrder<NoteSummary>(order, locales)
  const pinned = movedInOrder(was.groups.pinned, changed, compare)
  const others = movedInOrder(was.groups.others, changed, compare)
  return pinned === was.groups.pinned && others === was.groups.others
    ? was.groups
    : { pinned, others }
}

/**
 * The notes of a view (`bookId`, `by`) in `order`, pinned ones apart. A save
 * changes a few notes in their places (`earlierList`), and only those move, so
 * a large library is not sorted again for each.
 */
export function useNoteGroups(
  notes: NoteSummary[],
  books: readonly BookRecord[],
  bookId: string | null,
  by: NoteFilter | null,
  order: ListOrder,
  locales: readonly string[],
): Grouped {
  return useMemo(() => {
    const view: View = [books, bookId, by, order, locales]
    const groups = groupsOf(notes, view)
    grouped.set(notes, { view, groups })
    return groups
  }, [notes, books, bookId, by, order, locales])
}
