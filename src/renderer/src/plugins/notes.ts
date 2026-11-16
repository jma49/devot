// What a plugin with `notes.read` sees of the notes (ADR 0022): live notes outside Templates and the Trash, read through the
// core as the app reads them, never written.
import { TEMPLATES_BOOK_ID } from '../../../core/books'
import type { NoteSummary } from '../../../core/storage'
import type { Core } from '../core-client'
import type { PluginNoteSummary, PluginNotes } from './host'

const summary = (note: NoteSummary): PluginNoteSummary => ({
  id: note.id,
  title: note.title,
  notebook: note.bookId,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
})

export function pluginNotes(core: () => Core | undefined): PluginNotes {
  const need = () => {
    const c = core()
    if (!c) throw new Error('E_PLUGIN_UNAVAILABLE')
    return c
  }
  return {
    list: async (limit) => (await need().list(limit)).map(summary),
    search: async (query, limit) =>
      (await need().search(query, undefined, { flush: false })).found.slice(0, limit).map(summary),
    async get(id) {
      const note = await need()
        .read(id)
        .catch(() => {
          throw new Error('E_PLUGIN_NOTE_NOT_FOUND')
        })
      if (note.bookId === TEMPLATES_BOOK_ID) throw new Error('E_PLUGIN_NOTE_NOT_FOUND')
      return { id: note.id, title: note.title, notebook: note.bookId, markdown: note.bodyMd }
    },
    notebooks: async () =>
      (await need().listBooks())
        .filter((b) => b.deletedAt === null)
        .map((b) => ({ id: b.id, name: b.name, parent: b.parentId })),
  }
}
