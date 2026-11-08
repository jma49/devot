import type { WireStorage } from '../../storage/wire'
import {
  externalChangesReported,
  libraryWritesReported,
  noteWritesReported,
  type LibraryNotice,
} from './noteChanges'

export { externalChangesReported, type LibraryNotice }

/**
 * `storage` that also reports, a moment after they complete, the writes a note save does not: a
 * note's tags and its purge as note changes, and notebooks, tags and saved searches as one notice
 * each (docs/specs/iphone-screens.md, Keeping lists fresh).
 */
export function reportingListWrites(storage: WireStorage): WireStorage {
  let notes: Set<string> | undefined
  let library: Set<LibraryNotice> | undefined
  const flush = () => {
    const ids = notes
    const notices = library
    notes = undefined
    library = undefined
    if (ids) noteWritesReported(ids)
    for (const notice of notices ?? []) libraryWritesReported(notice)
  }
  const later = () => {
    if (!notes && !library) queueMicrotask(flush)
  }
  const note = (id: string) => {
    later()
    ;(notes ??= new Set()).add(id)
  }
  const changed = (notice: LibraryNotice) => {
    later()
    ;(library ??= new Set()).add(notice)
  }
  return {
    ...storage,
    async purgeNote(id, at, hlc) {
      await storage.purgeNote(id, at, hlc)
      note(id)
    },
    async putNoteTag(link) {
      await storage.putNoteTag(link)
      note(link.noteId)
    },
    async putBook(book) {
      await storage.putBook(book)
      changed('books.changed')
    },
    async putBooks(books) {
      await storage.putBooks(books)
      changed('books.changed')
    },
    async putTag(tag) {
      await storage.putTag(tag)
      changed('tags.changed')
    },
    async renameTag(tag, searches) {
      await storage.renameTag(tag, searches)
      changed('tags.changed')
      if (searches.length > 0) changed('savedSearches.changed')
    },
    async putSavedSearch(search) {
      await storage.putSavedSearch(search)
      changed('savedSearches.changed')
    },
  }
}
