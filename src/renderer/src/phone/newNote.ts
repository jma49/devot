import { errorCode } from '../../../core/errors'
import type { NoteSummary } from '../../../core/storage'
import { notebookForNewNote } from '../notebookChoices'

/** The notebook a new note goes to: the one Swift named, else the default one, else none. */
export const newNoteBook = (
  named: string | null,
  defaultNotebook: string | null,
  books: readonly { readonly id: string }[],
): string | null =>
  notebookForNewNote(
    named,
    defaultNotebook,
    books.map((book) => book.id),
  )

/** Makes the empty note New Note opens: no title, no body, status none. */
export const makeNewNote = (
  core: { create(title: string, bookId: string | null): Promise<string> },
  bookId: string | null,
) => core.create('', bookId)

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
