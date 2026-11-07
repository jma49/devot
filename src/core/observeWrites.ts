import type { StorageAdapter } from './storage'

/** `storage`, calling `changed` after each write: the Markdown mirror and sync follow writes through it. `changed` hears the notes a write changed when it changed nothing else. */
export function observeWrites(
  storage: StorageAdapter,
  changed: (noteIds?: readonly string[]) => void,
): StorageAdapter {
  const after =
    <A extends unknown[]>(
      write: (...args: A) => Promise<void>,
      notesOf?: (...args: A) => readonly string[],
    ) =>
    async (...args: A) => {
      await write(...args)
      changed(notesOf?.(...args))
    }
  return {
    listNotes: (page) => storage.listNotes(page),
    getSummaries: (ids) => storage.getSummaries(ids),
    getNote: (id, options) => storage.getNote(id, options),
    openNote: (id) => storage.openNote(id),
    getBodies: (ids) => storage.getBodies(ids),
    searchNotes: (query, limit) => storage.searchNotes(query, limit),
    listBacklinks: (id, excludeBookId, limit) => storage.listBacklinks(id, excludeBookId, limit),
    listTrash: () => storage.listTrash(),
    purgeNote: after((id: string, at: number, hlc: string) => storage.purgeNote(id, at, hlc)),
    putNote: after(
      (note) => storage.putNote(note),
      (note) => [note.id],
    ),
    putFile: after((meta, data) => storage.putFile(meta, data)),
    copyFiles: after((noteId, copies) => storage.copyFiles(noteId, copies)),
    listBooks: () => storage.listBooks(),
    isLiveBook: (id) => storage.isLiveBook(id),
    putBook: after((book) => storage.putBook(book)),
    putBooks: after((books) => storage.putBooks(books)),
    async seedWelcome(seed) {
      const seeded = await storage.seedWelcome(seed)
      if (seeded) changed()
      return seeded
    },
    listTags: () => storage.listTags(),
    putTag: after((tag) => storage.putTag(tag)),
    renameTag: after((tag, searches) => storage.renameTag(tag, searches)),
    listSavedSearches: () => storage.listSavedSearches(),
    putSavedSearch: after((search) => storage.putSavedSearch(search)),
    putNoteTag: after(
      (link) => storage.putNoteTag(link),
      (link) => [link.noteId],
    ),
    getNoteTag: (noteId, tagId) => storage.getNoteTag(noteId, tagId),
    putRevision: (revision) => storage.putRevision(revision),
    listRevisions: (noteId) => storage.listRevisions(noteId),
    getRevision: (id) => storage.getRevision(id),
    deleteRevisions: (noteId, ids) => storage.deleteRevisions(noteId, ids),
    listCompactable: (from, to, page, limit) => storage.listCompactable(from, to, page, limit),
    compactRevisions: (ids, sweptAt) => storage.compactRevisions(ids, sweptAt),
    lastCompaction: () => storage.lastCompaction(),
    listActivity: (since) => storage.listActivity(since),
    listNoteActivity: (ids, since) => storage.listNoteActivity(ids, since),
    listAgentWrites: (limit) => storage.listAgentWrites(limit),
    authoredNotes: () => storage.authoredNotes(),
    markAgentWritesSeen: (noteId, writeIds) => storage.markAgentWritesSeen(noteId, writeIds),
  }
}
