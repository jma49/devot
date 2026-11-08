import * as Y from 'yjs'
import { headline, listExcerpt, taskProgress, type TaskProgress } from '../extract'
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
  | 'taskCounts'
  | 'cardExcerpts'
> {
  const { live, holds } = ctx
  const { bodies, getStored, letGo, trim, using } = k.memory
  return {
    open: (id, known) =>
      using(id, (note) => ({
        id,
        title: note.record.title,
        state: known
          ? Y.encodeStateAsUpdate(note.doc, known)
          : (note.state ??= Y.encodeStateAsUpdate(note.doc)),
      })),

    title: (id) => using(id, (note) => note.record.title),

    hold(id) {
      holds.set(id, (holds.get(id) ?? 0) + 1)
    },

    unhold(id) {
      const left = (holds.get(id) ?? 0) - 1
      if (left > 0) holds.set(id, left)
      else if (holds.delete(id)) letGo(id)
      trim()
    },

    async read(id) {
      const note = live.get(id)
      if (note) {
        const { title, bookId } = note.record
        return { id, title, bodyMd: note.doc.getText(BODY).toString(), bookId }
      }
      const record = await getStored(id)
      if (!record) throw new Error('E_NOTE_NOT_FOUND')
      return { id, title: record.title, bodyMd: record.bodyMd, bookId: record.bookId }
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

    async taskCounts(ids) {
      const found: Record<string, TaskProgress> = {}
      for (const note of await bodies(ids)) found[note.id] = taskProgress(note.bodyMd)
      return found
    },

    async cardExcerpts(ids) {
      const found: Record<string, string> = {}
      for (const note of await bodies(ids)) found[note.id] = cardExcerpt(note.bodyMd, note.title)
      return found
    },
  }
}
