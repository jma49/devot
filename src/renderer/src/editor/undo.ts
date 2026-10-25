// The editor's one undo system is CodeMirror's history (`history()` in settings.ts); Cmd+Z, Shift+Cmd+Z and
// Edit > Undo and Redo reach it as `historyUndo` and `historyRedo` input events. It holds the user's own edits,
// one step per command and one per input method composition. Changes arriving from the Yjs document (sync,
// devot-mcp, the Markdown mirror, the core's merges) are not the user's: they bypass the history, which maps its
// steps through them. A restored version is the exception: the user asked for it, so it is a step of its own.
//
// A note keeps its history while another note is shown (the last `UNDO_NOTES` notes left), with the Yjs state its
// replica had then; shown again, the Yjs changes made meanwhile are applied without entering the history, exactly
// where they were made, so undo goes on with the user's own edits in their places. When those changes cannot be
// told, the note starts with no history. It is kept here, not in the core, so the core letting the note go does
// not touch it.
import { historyField, isolateHistory } from '@codemirror/commands'
import {
  ChangeSet,
  EditorState,
  Transaction,
  type StateEffect,
  type ChangeSpec,
  type EditorStateConfig,
  type Extension,
} from '@codemirror/state'
import { ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { BODY } from '../../../core/notes'

export const UNDO_NOTES = 10

/**
 * Keeps changes that come from the Yjs document out of the undo history;
 * while `restoring()` is true, the change is a restored version, which is an
 * undo step of its own instead, with the effects `restored()` gives.
 */
export function yjsHistory(
  restoring: () => boolean,
  restored: () => readonly StateEffect<unknown>[] = () => [],
): Extension {
  return EditorState.transactionExtender.of((tr) => {
    if (tr.annotation(ySyncAnnotation) === undefined) return null
    if (!restoring()) return { annotations: Transaction.addToHistory.of(false) }
    return { annotations: isolateHistory.of('full'), effects: restored() }
  })
}

interface Kept {
  text: string
  state: Uint8Array
  history: unknown
}

const kept = new Map<string, Kept>()

export function keepUndo(noteId: string, state: EditorState, doc: Y.Doc): void {
  const { history } = state.toJSON({ history: historyField }) as {
    history: unknown
  }
  kept.delete(noteId)
  kept.set(noteId, {
    text: state.doc.toString(),
    state: Y.encodeStateAsUpdate(doc),
    history,
  })
  for (const id of kept.keys()) {
    if (kept.size <= UNDO_NOTES) break
    kept.delete(id)
  }
}

/**
 * What changed in the note's body from `was` (a Yjs state) to `doc`, as
 * y-codemirror would apply it, or null when `doc` does not hold everything
 * `was` does, or the changes do not lead to `doc`'s text.
 */
function changesSince(was: Kept, doc: Y.Doc): ChangeSet | null {
  const old = new Y.Doc()
  try {
    Y.applyUpdate(old, was.state)
    const body = old.getText(BODY)
    if (body.toString() !== was.text) return null
    const known = Y.decodeStateVector(Y.encodeStateVector(doc))
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(old))) {
      if ((known.get(client) ?? 0) < clock) return null
    }
    // One Yjs transaction is one event; each is in the text as it was before it.
    let changes: ChangeSet | null = ChangeSet.empty(was.text.length)
    body.observe((event) => {
      if (!changes) return
      const specs: ChangeSpec[] = []
      let pos = 0
      for (const d of event.delta) {
        if (typeof d.insert === 'string') specs.push({ from: pos, insert: d.insert })
        else if (d.delete !== undefined) {
          specs.push({ from: pos, to: pos + d.delete })
          pos += d.delete
        } else if (d.retain !== undefined) pos += d.retain
        else {
          // Not text the editor shows (an embed): no exact changes.
          changes = null
          return
        }
      }
      changes = changes.compose(ChangeSet.of(specs, changes.newLength))
    })
    Y.applyUpdate(old, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(old)))
    return body.toString() === doc.getText(BODY).toString() ? changes : null
  } catch {
    return null
  } finally {
    old.destroy()
  }
}

/**
 * The editor state for a note being shown: `config` as it is (its `doc` is
 * the text of `doc`, the note's Yjs document), with the history the note had
 * when it was left, mapped through what changed since.
 */
export function noteState(
  noteId: string,
  config: EditorStateConfig & { doc: string },
  doc: Y.Doc,
): EditorState {
  const was = kept.get(noteId)
  if (!was) return EditorState.create(config)
  kept.delete(noteId)
  const changes = changesSince(was, doc)
  if (!changes) return EditorState.create(config)
  const state = EditorState.fromJSON(
    {
      doc: was.text,
      selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
      history: was.history,
    },
    { extensions: config.extensions ?? [] },
    { history: historyField },
  )
  const next = state.update({
    changes,
    selection: config.selection ?? { anchor: 0 },
    annotations: Transaction.addToHistory.of(false),
    // The note's text as it is, whatever the editor's filters would make of an edit.
    filter: false,
  }).state
  return next.doc.toString() === config.doc ? next : EditorState.create(config)
}
