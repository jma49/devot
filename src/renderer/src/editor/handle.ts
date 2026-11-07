import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'
import { reviewSteps, type ReviewStep } from '../../../core/authorship'
import type { ImageSize } from '../../../core/images'
import type { CommandId } from '../commands/registry'
import { imageMenuTarget, type ImageMenuTarget, type ImageSource } from '../imageMenu'
import { moveRange, moveSelection, selectedText } from './extract'
import { formatCommand, type FormatId } from './formats'
import { acceptSpec, suggestAt } from './ghostText'
import { imageAt, viewImageAt } from './images'
import { insertCommand, type InsertId } from './insert'
import { replayEarlyKeys, type EarlyKey } from './earlyKeys'
import { linkForNewNote, runEditCommand, type LinkAt } from './lineCommands'
import { pastePlain, pasteUrlAsIn, setImageSize } from './noteKeys'
import { TABLE_COMMANDS, inTable, type TableCommandId } from './tableCommands'
import { taskToggle } from './tasks'

/** The origin of updates the core sent: shown, never sent back. */
export const REMOTE = 'remote'

export interface EditorHandle {
  noteId: string
  /** The replica's state vector, so the core sends only what it lacks (NoteService.open). */
  vector: () => Uint8Array
  /** Takes in the core's state after it merged another process's writes: shown outside the undo history, not sent back. */
  takeState: (state: Uint8Array) => void
  /** Like `takeState`, for a change the user asked for (a template filling the note): one undo step, not sent back. */
  takeStep: (state: Uint8Array) => void
  focus: () => void
  focusStart: () => void
  /** Types `keys` at the caret as if they had been pressed there. */
  type: (keys: readonly EarlyKey[]) => void
  remeasure: () => void
  format: (id: FormatId) => void
  insert: (id: InsertId) => void
  text: () => string
  /** Caret to the start of line `line` (1-based), scrolled to the view's top (outline entry) or middle (Go to Line). */
  goToLine: (line: number, where?: 'start' | 'center', focus?: boolean) => void
  inTable: () => boolean
  table: (id: TableCommandId) => void
  hasSelection: () => boolean
  /** Hands the selected text to `make` and puts the text it resolves to (a note link) in its place, as one undo step (editor/extract.ts). */
  moveSelection: (make: (text: string) => Promise<string | null>) => Promise<boolean>
  linkAtCursor: () => LinkAt | null
  /** Like `moveSelection`, for a range. */
  moveRange: (
    from: number,
    to: number,
    make: (text: string) => Promise<string | null>,
  ) => Promise<boolean>
  pastePlain: () => Promise<void>
  suggest: () => void
  /** Takes the inline suggestion shown at the caret; false when none is shown. */
  acceptSuggestion: () => boolean
  runLine: (id: CommandId) => void
  pasteUrlAs: () => Promise<void>
  imageAtCursor: () => ImageMenuTarget | null
  /** Shows that image in the viewer (an attachment only); false when there is none. */
  viewImage: () => boolean
  /** Gives the image at `source` a size as one change; false when that text is no longer that image. */
  setImageSize: (source: ImageSource, size: ImageSize) => boolean
  /** Ticks or unticks the task whose mark is at `at` as one change; false when no box is there any more. */
  toggleTask: (at: number) => boolean
  /** Review Changes: the places the writes in `writeIds` changed, as the replica has them now (reviewSteps). */
  reviewSteps: (writeIds: ReadonlySet<string>) => ReviewStep[]
  /** Selects `from`-`to` and scrolls it to the middle, leaving the keyboard where it is. */
  reveal: (from: number, to: number) => void
}

/** What the window does with the note shown in `ready`; `isShown` is false once the editor has moved on to another note. */
export function editorHandle(
  ready: EditorView,
  doc: Y.Doc,
  noteId: string,
  takeStep: (state: Uint8Array) => void,
  isShown: () => boolean,
): EditorHandle {
  return {
    noteId,
    vector: () => Y.encodeStateVector(doc),
    takeState: (update) => Y.applyUpdate(doc, update, REMOTE),
    takeStep,
    focus: () => ready.focus(),
    focusStart: () => {
      ready.focus()
      ready.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
    },
    type: (keys) => replayEarlyKeys(ready, keys),
    remeasure: () => ready.requestMeasure(),
    format: (id) => {
      ready.focus()
      formatCommand(id)(ready)
    },
    insert: (id) => {
      ready.focus()
      insertCommand(id)(ready)
    },
    text: () => ready.state.doc.toString(),
    goToLine: (line, where = 'start', focus = true) => {
      const lines = ready.state.doc
      const at = lines.line(Math.min(lines.lines, Math.max(1, Math.floor(line)))).from
      if (focus) ready.focus()
      ready.dispatch({
        selection: EditorSelection.cursor(at),
        effects: EditorView.scrollIntoView(
          at,
          where === 'center' ? { y: 'center' } : { y: 'start', yMargin: 24 },
        ),
      })
    },
    inTable: () => inTable(ready.state),
    table: (id) => {
      ready.focus()
      const tr = TABLE_COMMANDS[id](ready.state)
      if (tr) ready.dispatch(tr)
    },
    hasSelection: () => selectedText(ready.state) !== null,
    moveSelection: (make) => moveSelection(ready, make, isShown),
    linkAtCursor: () => linkForNewNote(ready.state, ready.state.selection.main.head) ?? null,
    moveRange: (from, to, make) => moveRange(ready, from, to, make, isShown),
    pastePlain: () => {
      ready.focus()
      return pastePlain(ready)
    },
    suggest: () => {
      ready.focus()
      suggestAt(ready)
    },
    acceptSuggestion: () => {
      const spec = acceptSpec(ready.state)
      if (spec) ready.dispatch(spec)
      return spec !== null
    },
    runLine: (id) => {
      ready.focus()
      runEditCommand(ready, id)
    },
    pasteUrlAs: () => {
      ready.focus()
      return pasteUrlAsIn(ready)
    },
    imageAtCursor: () => {
      const image = imageAt(ready.state, ready.state.selection.main.head)
      return image ? imageMenuTarget(image) : null
    },
    viewImage: () => viewImageAt(ready),
    setImageSize: (source, size) => setImageSize(ready, source, size),
    toggleTask: (at) => {
      const change = taskToggle(ready.state, at)
      if (change) ready.dispatch(change)
      return change !== null
    },
    reviewSteps: (writeIds) => reviewSteps(doc, writeIds, noteId),
    reveal: (from, to) => {
      const length = ready.state.doc.length
      const anchor = Math.min(from, length)
      const head = Math.min(to, length)
      ready.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(EditorSelection.range(anchor, head), {
          y: 'center',
        }),
      })
    },
  }
}
