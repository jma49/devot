import * as Y from 'yjs'
import { headline, listExcerpt, taskProgress } from '../extract'
import { cardExcerpt } from '../preview/cardExcerpt'
import { BODY } from './body'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { RowDetail, NoteService } from './types'

export function readingMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<
  NoteService,
  | 'open'
  | 'title'
  | 'hold'
  | 'unhold'
  | 'read'
  | 'headlines'
  | 'excerpts'
  | 'rowDetails'
  | 'cardExcerpts'
> {
  const { live, holds } = ctx
  const { bodies, getStored, trim, using } = k.memory
  return {
    open: (id, known) =>
      using(id, (note) => ({
        id,
        title: note.record.title,
        state: Y.encodeStateAsUpdate(note.doc, known),
      })),

    title: (id) => using(id, (note) => note.record.title),

    hold(id) {
      holds.set(id, (holds.get(id) ?? 0) + 1)
    },

    unhold(id) {
      const left = (holds.get(id) ?? 0) - 1
      if (left > 0) holds.set(id, left)
      else holds.delete(id)
      trim()
    },

    async read(id) {
      const note = live.get(id)
      const record = note?.record ?? (await getStored(id))
      if (!record) throw new Error('E_NOTE_NOT_FOUND')
      const bodyMd = note ? note.doc.getText(BODY).toString() : record.bodyMd
      return { id, title: record.title, bodyMd, bookId: record.bookId }
    },

    async headlines(ids) {
      const found: Record<string, string> = {}
      for (const note of await bodies(ids)) found[note.id] = headline(note.bodyMd)
      return found
    },

    async excerpts(ids) {
      const found: Record<string, string> = {}
      for (const note of await bodies(ids)) found[note.id] = listExcerpt(note.bodyMd, note.title)
      return found
    },

    async rowDetails(ids) {
      const found: Record<string, RowDetail> = {}
      for (const note of await bodies(ids)) {
        const { done, total } = taskProgress(note.bodyMd)
        found[note.id] = {
          excerpt: listExcerpt(note.bodyMd, note.title),
          progress: total > 0 ? `${done}/${total}` : '',
        }
      }
      return found
    },

    async cardExcerpts(ids) {
      const found: Record<string, string> = {}
      for (const note of await bodies(ids)) found[note.id] = cardExcerpt(note.bodyMd, note.title)
      return found
    },
  }
}
