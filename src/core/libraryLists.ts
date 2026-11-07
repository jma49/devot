// What a window does with the library's lists at start, kept apart from the template and welcome services, whose imports are too heavy for the window's startup bundle.
import type { NoteSummary } from './storage'
import { TEMPLATES_BOOK_ID } from './templatesBook'

/** A whole list of notes (`StorageAdapter.listNotes`) as the library's notes and the templates, in one pass. */
export function splitTemplates(listed: readonly NoteSummary[]): {
  notes: NoteSummary[]
  templates: NoteSummary[]
} {
  const notes: NoteSummary[] = []
  const templates: NoteSummary[] = []
  for (const note of listed) (note.bookId === TEMPLATES_BOOK_ID ? templates : notes).push(note)
  return { notes, templates }
}

/** A library's lists: its notes, Trash and notebooks, as `StorageAdapter` lists them. */
export interface ListedLibrary {
  notes: readonly { bookId: string | null }[]
  trash: readonly unknown[]
  books: readonly { id: string }[]
}

/**
 * Whether the lists show a library that has never held anything; the Templates notebook, made on demand, is not the user's.
 * Lists that show anything else mean the first-launch seed (core/welcome.ts) would write nothing, so a start can leave it alone.
 */
export function holdsNothing({ notes, trash, books }: ListedLibrary): boolean {
  return (
    notes.every((n) => n.bookId === TEMPLATES_BOOK_ID) &&
    trash.length === 0 &&
    books.every((b) => b.id === TEMPLATES_BOOK_ID)
  )
}
