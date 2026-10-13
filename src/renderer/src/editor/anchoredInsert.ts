// Text that arrives a moment after the user asked for it (an image link once
// its file is stored) goes where the user asked, however the note changed
// meanwhile. The place is remembered as a Yjs relative position: it follows
// every edit, the user's, a restored version's or another process's, and
// means the same place in the editor's replica and in the core's document.
// If the editor has closed (another note was opened), the core inserts the
// text into the note itself; if the same note is open again, its editor does.
import { isolateHistory } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import type { Core } from '../core-client'

interface OpenEditor {
  view: EditorView
  doc: Y.Doc
  text: Y.Text
}

/** The editor that shows each note now. */
const editors = new Map<string, OpenEditor>()

/**
 * Registers the editor that shows a note; returns the call that takes it
 * out again when it closes.
 */
export function trackOpenEditor(noteId: string, view: EditorView, doc: Y.Doc, text: Y.Text) {
  const entry: OpenEditor = { view, doc, text }
  editors.set(noteId, entry)
  return () => {
    if (editors.get(noteId) === entry) editors.delete(noteId)
  }
}

/**
 * The place at `pos` of the body, to insert at later. Text typed at the
 * place afterwards goes after what is inserted there.
 */
export function anchorAt(text: Y.Text, pos: number): Uint8Array {
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, pos, -1))
}

/**
 * Inserts `markdown` at the remembered place in the note, as one undo step
 * of its own. The caret moves after it only when it is still at the place.
 * Rejects (E_NOTE_NOT_FOUND) when no editor shows the note and the core has
 * lost it, a note deleted meanwhile.
 */
export async function insertAtAnchor(
  core: Pick<Core, 'insertAt'>,
  noteId: string,
  anchor: Uint8Array,
  markdown: string,
): Promise<void> {
  const open = editors.get(noteId)
  if (!open?.view.dom.isConnected) {
    await core.insertAt(noteId, anchor, markdown)
    return
  }
  const { view, doc, text } = open
  const found = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(anchor), doc)
  const length = view.state.doc.length
  const at = found?.type === text ? Math.min(found.index, length) : length
  const caret = view.state.selection.main
  view.dispatch({
    changes: { from: at, insert: markdown },
    ...(caret.empty && caret.head === at ? { selection: { anchor: at + markdown.length } } : {}),
    annotations: isolateHistory.of('full'),
  })
}
