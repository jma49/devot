// The editor's one undo system is CodeMirror's history (`history()` in settings.ts); Cmd+Z, Shift+Cmd+Z and
// Edit > Undo and Redo reach it as `historyUndo` and `historyRedo` input events. It holds the user's own edits,
// one step per command and one per input method composition. Changes arriving from the Yjs document (sync,
// an outside writer, the Markdown mirror, the core's merges) are not the user's: they bypass the history, which maps its
// steps through them. A restored version is the exception: the user asked for it, so it is a step of its own.
//
// A note keeps its history while another note is shown (the last `UNDO_NOTES` notes left), with the Yjs state its
// replica had then; shown again, the Yjs changes made meanwhile are applied without entering the history, exactly
// where they were made, so undo goes on with the user's own edits in their places. When those changes cannot be
// told, the note starts with no history. It is kept here, not in the core, so the core letting the note go does
// not touch it.
import {
  history as historyExtension,
  historyField,
  isolateHistory,
  redoDepth,
  undoDepth,
} from '@codemirror/commands'
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  Transaction,
  type StateEffect,
  type Text,
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
  /** The editor's text when left, which was the replica's. */
  text: Text
  length: number
  vector: Uint8Array
  history: unknown
  /** The replica as it was left: encoded after the next paint, or when asked first (see stateOf). */
  doc: Y.Doc | undefined
  state: Uint8Array | undefined
}

const kept = new Map<string, Kept>()

// A hidden window paints no frames, so the timer bounds how long a left replica is held.
const PAINT_FALLBACK_MS = 1000

const afterPaint = (work: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(work))
  setTimeout(work, PAINT_FALLBACK_MS)
}

/** The replica left, encoded; undefined when it changed since it was left, which an editor never does. */
function stateOf(was: Kept): Uint8Array | undefined {
  const doc = was.doc
  if (!doc) return was.state
  was.doc = undefined
  was.state = sameInsertions(was, doc) ? Y.encodeStateAsUpdate(doc) : undefined
  return was.state
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Keeps the note's history, with its replica `doc`, which the editor no longer changes: it is
 * encoded only after the next paint, so leaving a note costs the switch little.
 */
export function keepUndo(noteId: string, state: EditorState, doc: Y.Doc): void {
  forget(noteId)
  if (undoDepth(state) === 0 && redoDepth(state) === 0) return
  const length = doc.getText(BODY).length
  if (state.doc.length !== length) return
  const { history } = state.toJSON({ history: historyField }) as { history: unknown }
  const was: Kept = {
    text: state.doc,
    length,
    vector: Y.encodeStateVector(doc),
    history,
    doc,
    state: undefined,
  }
  kept.set(noteId, was)
  afterPaint(() => void stateOf(was))
  for (const id of kept.keys()) {
    if (kept.size <= UNDO_NOTES) break
    forget(id)
  }
}

function forget(noteId: string) {
  const was = kept.get(noteId)
  if (!was) return
  was.doc = undefined
  kept.delete(noteId)
}

/**
 * What changed in the note's body from `was` to `doc`, as y-codemirror would apply it, with the
 * text `was` had; null when `doc` does not hold everything `was` does, or the changes do not lead
 * to `doc`'s text.
 */
function changesSince(was: Kept, doc: Y.Doc): { text: string; changes: ChangeSet } | null {
  const state = stateOf(was)
  if (!state) return null
  const known = Y.decodeStateVector(Y.encodeStateVector(doc))
  for (const [client, clock] of Y.decodeStateVector(was.vector)) {
    if ((known.get(client) ?? 0) < clock) return null
  }
  const old = new Y.Doc()
  try {
    Y.applyUpdate(old, state)
    const body = old.getText(BODY)
    const text = body.toString()
    // One Yjs transaction is one event; each is in the text as it was before it.
    let changes: ChangeSet | null = ChangeSet.empty(text.length)
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
    // Both replicas hold the same changes now, so the same text.
    const done = changes as ChangeSet | null
    return done && done.newLength === doc.getText(BODY).length ? { text, changes: done } : null
  } catch {
    return null
  } finally {
    old.destroy()
  }
}

/**
 * Holds the insertions `was` holds and no others, with as much text; its deletions can still
 * differ, since they do not move the state vector.
 */
function sameInsertions(was: Kept, doc: Y.Doc): boolean {
  return doc.getText(BODY).length === was.length && sameBytes(Y.encodeStateVector(doc), was.vector)
}

/** The history `was` kept, mapped through what changed in `doc` since; null when that cannot be told. */
function mappedHistory(was: Kept, doc: Y.Doc): unknown {
  const since = changesSince(was, doc)
  if (!since) return null
  const left = EditorState.fromJSON(
    {
      doc: since.text,
      selection: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
      history: was.history,
    },
    { extensions: historyExtension() },
    { history: historyField },
  )
  const mapped = left.update({
    changes: since.changes,
    annotations: Transaction.addToHistory.of(false),
    filter: false,
  }).state
  return (mapped.toJSON({ history: historyField }) as { history: unknown }).history
}

const selectionJSON = (selection: EditorStateConfig['selection']) =>
  (selection instanceof EditorSelection
    ? selection
    : EditorSelection.single(selection?.anchor ?? 0, selection?.head)
  ).toJSON()

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
  const withHistory = (history: unknown) =>
    EditorState.fromJSON(
      { doc: config.doc, selection: selectionJSON(config.selection), history },
      { extensions: config.extensions ?? [] },
      { history: historyField },
    )
  try {
    if (sameInsertions(was, doc)) {
      const state = withHistory(was.history)
      if (state.doc.eq(was.text)) return state
    }
    const mapped = mappedHistory(was, doc)
    return mapped === null ? EditorState.create(config) : withHistory(mapped)
  } finally {
    forget(noteId)
  }
}
