import * as Y from 'yjs'
import { clipTitle } from '../noteLimits'
import type { NoteRecord } from '../storage'
import { BODY } from './body'
import { untilWritten } from './records'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

export function trashMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'trash' | 'restore' | 'listTrash' | 'peekTrashed' | 'purge' | 'emptyTrash'> {
  const { storage, clock, now, live } = ctx
  const { takeVersion, settled } = k.versions
  const { relay } = k.relay
  const { drop, getStored, using } = k.memory
  const { exclusive, failed, put, rowsOf, write, save } = k.saving
  const trashed = async (id: string): Promise<NoteRecord> => {
    const record = await getStored(id, { trashed: true })
    if (!record || record.deletedAt === null) throw new Error('E_NOTE_NOT_IN_TRASH')
    return record
  }

  return {
    async trash(id) {
      await using(id, async (note) => {
        clearTimeout(note.timer)
        note.timer = undefined
        await exclusive(note, async () => {
          try {
            await write(note)
          } catch (error) {
            failed(note, error)
            throw error
          }
          if (live.get(id) !== note) return
          takeVersion(note)
          // Written apart: when it fails, the note stays as it was. With the
          // body as the document holds it, which may have taken in what
          // another process wrote since the last write (see mergeStored).
          await put(note, () => {
            const { changed } = rowsOf(note)
            return {
              ...note.record,
              bodyMd: note.doc.getText(BODY).toString(),
              ydoc: Y.encodeStateAsUpdate(note.doc),
              deletedAt: now(),
              deletedHlc: clock.tick(),
              ...(changed ? { agentWrites: changed } : {}),
            }
          })
          drop(note)
        })
      })
      relay({ kind: 'gone', noteId: id, purged: false })
      await settled()
    },

    restore: (id) =>
      untilWritten(async () => {
        const record = await trashed(id)
        // A title stored past what storage takes now (by an older build) is
        // cut for the write, as when a note is loaded; the stored one stays.
        await storage.putNote({
          ...record,
          title: clipTitle(record.title),
          deletedAt: null,
          deletedHlc: clock.tick(),
        })
      }),

    listTrash: () => storage.listTrash(),

    async peekTrashed(id) {
      const record = await trashed(id)
      const { title, bodyMd, createdAt, updatedAt } = record
      return { id, title, bodyMd, createdAt, updatedAt }
    },

    async purge(id) {
      await trashed(id)
      // Storage keeps the attachments other notes show: a link pasted a
      // moment ago, its save still waiting, counts too.
      await Promise.all([...live.values()].map(save))
      await storage.purgeNote(id, now(), clock.tick())
      const note = live.get(id)
      if (note) drop(note)
      relay({ kind: 'gone', noteId: id, purged: true })
    },

    async emptyTrash() {
      await Promise.all([...live.values()].map(save))
      const all = await storage.listTrash()
      for (const note of all) await storage.purgeNote(note.id, now(), clock.tick())
      // Each window that shows one of them hears it is gone, as for a single purge.
      for (const note of all) relay({ kind: 'gone', noteId: note.id, purged: true })
      return all.length
    },
  }
}
