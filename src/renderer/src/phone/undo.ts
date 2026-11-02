import type { NoteStatus, NoteSummary } from '../../../core/storage'

/** What undoing needs of the core, in the worker's words. */
export interface UndoCore {
  setStatus(id: string, status: NoteStatus): Promise<void>
  setNoteDates(id: string, dates: { updatedAt: number }): Promise<void>
  trash(id: string): Promise<void>
  restore(id: string): Promise<void>
}

export interface UndoEntry {
  readonly kind: 'trash' | 'complete'
  readonly noteId: string
  readonly status: NoteStatus
  readonly updatedAt: number
  /** The action itself: an undo waits for it. */
  readonly done: Promise<void>
}

const entry = (kind: UndoEntry['kind'], note: NoteSummary, done: Promise<void>): UndoEntry => ({
  kind,
  noteId: note.id,
  status: note.status,
  updatedAt: note.updatedAt,
  done,
})

export const trashNote = (core: UndoCore, note: NoteSummary): UndoEntry =>
  entry('trash', note, core.trash(note.id))

/** Null when the note is already completed: there is nothing to do, or to undo. */
export const completeNote = (core: UndoCore, note: NoteSummary): UndoEntry | null =>
  note.status === 'completed' ? null : entry('complete', note, core.setStatus(note.id, 'completed'))

/** Puts the note back as it was, its place in the list too: a status write moves `updatedAt`. */
export async function undoNote(core: UndoCore, undo: UndoEntry): Promise<void> {
  await undo.done
  if (undo.kind === 'trash') {
    await core.restore(undo.noteId)
    return
  }
  await core.setStatus(undo.noteId, undo.status)
  await core.setNoteDates(undo.noteId, { updatedAt: undo.updatedAt })
}
