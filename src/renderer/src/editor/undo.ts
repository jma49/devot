// The editor's one undo system is CodeMirror's history (`history()` in
// settings.ts; Cmd+Z, Shift+Cmd+Z and Edit > Undo and Redo, which reach the
// page as `historyUndo` and `historyRedo` input events, all go to it). It
// holds the user's own edits in this editor, each command one step, and an
// input method's composition as one step. What reaches the editor from its
// Yjs document is not the user's: sync, another process (devot-mcp, the
// Markdown mirror) and the core's merges change the text without entering
// the history, which maps its steps through them instead. A restored version
// is the one exception: the user asked for it, so it is a step of its own.
//
// A note keeps its history while another note is shown (the last
// `UNDO_NOTES` notes left), with the Yjs state its replica had then; shown
// again, the Yjs changes made meanwhile are applied without entering the
// history, exactly where they were made (as y-codemirror applies a change
// while the note is open), so undo goes on with the user's own edits in their
// places. When those changes cannot be told (the note's document is not the
// one it was left with), the note starts with no history. It is kept here,
// not in the core, so the core letting the note go from memory does not
// touch it.
import { historyField, isolateHistory } from '@codemirror/commands'
import {
  ChangeSet,
  EditorState,
  Transaction,
  type ChangeSpec,
  type EditorStateConfig,
  type Extension,
} from '@codemirror/state'
import { ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import { BODY } from '../../../core/notes'

/** How many notes, once left, keep their undo history. */
export const UNDO_NOTES = 10

/**
 * Keeps changes that come from the Yjs document out of the undo history;
 * while `restoring()` is true, the change is a restored version, which is an
 * undo step of its own instead.
 */
export function yjsHistory(restoring: () => boolean): Extension {
  return EditorState.transactionExtender.of((tr) => {
    if (tr.annotation(ySyncAnnotation) === undefined) return null
    return {
      annotations: restoring() ? isolateHistory.of('full') : Transaction.addToHistory.of(false),
    }
  })
}

interface Kept {
  /** The note's text when it was left. */
  text: string
  /** The replica's Yjs state when it was left. */
  state: Uint8Array
  /** The history field, serialised. */
  history: unknown
}

/** The histories of the notes left, the least recently left first. */
const kept = new Map<string, Kept>()

/** Keeps the undo history of a note the editor leaves, with its Yjs replica `doc`. */
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
  // Shown again, it is kept anew when it is left.
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
