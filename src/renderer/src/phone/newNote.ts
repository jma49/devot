import { errorCode } from '../../../core/errors'
import type { NoteSummary } from '../../../core/storage'
import { notebookForNewNote } from '../notebookChoices'
import type { PhoneStatusFilter, PhoneView } from './library'
import type { PhoneNavigation, PhoneRoute, PhoneTab } from './navigation'

/** The notes a screen lists: the Notes root (a smart tile's view and status) or a pushed list. */
export interface ShownList {
  readonly view: PhoneView
  readonly status: PhoneStatusFilter
}

export type NewNoteKind = 'note' | 'template'

/** What New Note makes from the screen on top, or null where it is not offered. */
export function newNoteOffered(
  tab: PhoneTab,
  top: PhoneRoute,
  list: ShownList | null,
): NewNoteKind | null {
  if (list) {
    if (list.view.kind === 'trash') return null
    return list.view.kind === 'templates' ? 'template' : 'note'
  }
  return tab === 'library' && top.screen === 'root' ? 'note' : null
}

/** The notebook a note made from `list` goes to: the one it shows, else the default one, else none. */
export const newNoteBook = (
  list: ShownList | null,
  defaultNotebook: string | null,
  books: readonly { readonly id: string }[],
): string | null =>
  notebookForNewNote(
    list?.view.kind === 'book' ? list.view.id : undefined,
    defaultNotebook,
    books.map((book) => book.id),
  )

/**
 * The list slid in under a new note's editor when the one shown would not list it, so Back finds
 * the note: its notebook's list, or All Notes. Null when the list shown has it already.
 */
export function listUnderNewNote(
  list: ShownList | null,
  kind: NewNoteKind,
  bookId: string | null,
): PhoneView | null {
  if (kind === 'template') return null
  if (list && list.status === 'all') {
    if (list.view.kind === 'all') return null
    if (list.view.kind === 'book' && list.view.id === bookId) return null
  }
  return bookId === null ? { kind: 'all' } : { kind: 'book', id: bookId }
}

interface Making {
  create(title: string, bookId: string | null): Promise<string>
  createTemplate(): Promise<string>
}

/** Makes the empty note (or template) New Note opens: no title, no body, status none. */
export const makeNewNote = (core: Making, kind: NewNoteKind, bookId: string | null) =>
  kind === 'template' ? core.createTemplate() : core.create('', bookId)

/** A note New Note made, as it was made. */
export interface MadeNote {
  readonly bookId: string | null
}

/** Whether a note New Note made is still as made: no title and no chip changed. */
export const untouched = (made: MadeNote, now: NoteSummary | undefined): boolean =>
  now !== undefined &&
  now.title === '' &&
  now.bookId === made.bookId &&
  now.status === 'none' &&
  !now.pinned &&
  now.tagIds.length === 0

const freshNotes = (state: PhoneNavigation): Set<string> =>
  new Set(
    Object.values(state.stacks).flatMap((stack) =>
      stack.flatMap((route) => (route.fresh && route.noteId ? [route.noteId] : [])),
    ),
  )

/** The notes New Note made that `before` showed and `after` shows on no tab: their screen was left. */
export function newNotesLeft(before: PhoneNavigation, after: PhoneNavigation): string[] {
  const kept = freshNotes(after)
  return [...freshNotes(before)].filter((id) => !kept.has(id))
}

/**
 * Deletes a new note left untouched, for good and without the Trash. Storage refuses one that has
 * a title or a body by now (sync wrote into it), and the note is kept.
 */
export async function discardNewNote(
  core: { discardEmpty(id: string): Promise<void> },
  id: string,
): Promise<boolean> {
  try {
    await core.discardEmpty(id)
    return true
  } catch (error) {
    console.warn(`W_PHONE_DISCARD_REFUSED code=${errorCode(error)}`)
    return false
  }
}
