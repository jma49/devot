import type { StatusUndo } from '../../../core/notes'
import type { NoteStatus, NoteSummary } from '../../../core/storage'

/** What undoing needs of the core, in the worker's words. */
export interface UndoCore {
  setStatusUndoable(id: string, status: NoteStatus): Promise<StatusUndo>
  undoStatus(id: string, undo: StatusUndo): Promise<void>
  trash(id: string): Promise<void>
  restore(id: string): Promise<void>
}

/** `done` is the action itself: an undo waits for it. */
export type UndoEntry =
  | {
      readonly kind: 'trash'
      readonly noteId: string
      readonly done: Promise<void>
    }
  | {
      readonly kind: 'complete'
      readonly noteId: string
      readonly done: Promise<StatusUndo>
    }

export const trashNote = (core: UndoCore, note: NoteSummary): UndoEntry => ({
  kind: 'trash',
  noteId: note.id,
  done: core.trash(note.id),
})

/** Null when the note is already completed: there is nothing to do, or to undo. */
export const completeNote = (core: UndoCore, note: NoteSummary): UndoEntry | null =>
  note.status === 'completed'
    ? null
    : {
        kind: 'complete',
        noteId: note.id,
        done: core.setStatusUndoable(note.id, 'completed'),
      }

export async function undoNote(core: UndoCore, undo: UndoEntry): Promise<void> {
  if (undo.kind === 'trash') {
    await undo.done
    await core.restore(undo.noteId)
    return
  }
  await core.undoStatus(undo.noteId, await undo.done)
}
