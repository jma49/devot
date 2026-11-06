import * as Y from 'yjs'
import { applyAgentEdit } from '../authorship'
import { textEdits } from '../diff'
import { clipTitle } from '../noteLimits'
import { BODY } from './body'
import type { Live, NoteContext } from './context'
import type { Kernel } from './kernel'
import type { AgentNoteWrite } from './types'

/** Changes to a note in memory that several service calls make. */
export function createEdits(ctx: NoteContext, k: Pick<Kernel, 'versions' | 'relay' | 'saving'>) {
  const { clock, now, options } = ctx
  const { editBody } = k.versions
  const { relay } = k.relay
  const { schedule } = k.saving
  const retitle = (note: Live, title: string) => {
    note.record = {
      ...note.record,
      title: clipTitle(title),
      titleHlc: clock.tick(),
    }
    schedule(note)
    const { id, title: clipped, titleHlc } = note.record
    relay({ kind: 'title', noteId: id, title: clipped, hlc: titleHlc })
  }

  const replaceBody = (note: Live, markdown: string) => {
    const text = note.doc.getText(BODY)
    const edits = textEdits(text.toString(), markdown)
    if (edits.length === 0) return
    editBody(note, () =>
      note.doc.transact(() => {
        // From the end, so the offsets still ahead stay right.
        for (const edit of edits.reverse()) {
          if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start)
          if (edit.text) text.insert(edit.start, edit.text)
        }
      }),
    )
    schedule(note)
  }

  /** Runs `change` on the note's document and returns the Yjs update it made, for the editor's replica. */
  const collected = (note: Live, change: () => void): Uint8Array => {
    const updates: Uint8Array[] = []
    const collect = (update: Uint8Array) => updates.push(update)
    note.doc.on('update', collect)
    try {
      change()
    } finally {
      note.doc.off('update', collect)
    }
    return Y.mergeUpdates(updates)
  }

  /** An agent's write and its record, as one transaction (applyAgentEdit). */
  const authoredEdit = (note: Live, edit: AgentNoteWrite): string | null => {
    let writeId: string | null = null
    editBody(note, () => {
      writeId = applyAgentEdit(note.doc, { ...edit, at: now() })
    })
    if (writeId === null) return null
    schedule(note)
    options.log?.('I_AUTHORSHIP_WRITE', note.record.id, writeId, edit.writer.kind)
    return writeId
  }

  return { retitle, replaceBody, collected, authoredEdit }
}
