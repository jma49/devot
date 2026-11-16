// What a plugin with `notes.read` sees of the notes (ADR 0022, 0028): live notes outside Templates and the Trash, read through
// the core as the app reads them, never written.
import { TEMPLATES_BOOK_ID } from '../../../core/books'
import type { NoteSummary } from '../../../core/storage'
import type { Core } from '../core-client'
import type { PluginNoteSummary, PluginNotes } from './host'

const summary =
  (tagNames: ReadonlyMap<string, string>) =>
  (note: NoteSummary): PluginNoteSummary => ({
    id: note.id,
    title: note.title,
    notebook: note.bookId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    tags: note.tagIds.flatMap((id) => {
      const name = tagNames.get(id)
      return name === undefined ? [] : [name]
    }),
    status: note.status,
    pinned: note.pinned,
  })

export function pluginNotes(core: () => Core | undefined): PluginNotes {
  const need = () => {
    const c = core()
    if (!c) throw new Error('E_PLUGIN_UNAVAILABLE')
    return c
  }
  const named = async () =>
    summary(
      new Map(
        (await need().listTags()).filter((t) => t.deletedAt === null).map((t) => [t.id, t.name]),
      ),
    )
  return {
    list: async (limit) => {
      const [notes, toSummary] = await Promise.all([need().list(limit), named()])
      return notes.map(toSummary)
    },
    search: async (query, limit) => {
      const [found, toSummary] = await Promise.all([
        need().search(query, undefined, { flush: false }),
        named(),
      ])
      return found.found.slice(0, limit).map(toSummary)
    },
    async get(id) {
      const note = await need()
        .read(id)
        .catch(() => {
          throw new Error('E_PLUGIN_NOTE_NOT_FOUND')
        })
      if (note.bookId === TEMPLATES_BOOK_ID) throw new Error('E_PLUGIN_NOTE_NOT_FOUND')
      // Loaded on the first read, so the main window starts without the Markdown parser.
      const { noteProperties } = await import('../../../core/frontMatter')
      return {
        id: note.id,
        title: note.title,
        notebook: note.bookId,
        markdown: note.bodyMd,
        properties: noteProperties(note.bodyMd),
      }
    },
    notebooks: async () =>
      (await need().listBooks())
        .filter((b) => b.deletedAt === null)
        .map((b) => ({ id: b.id, name: b.name, parent: b.parentId })),
  }
}
