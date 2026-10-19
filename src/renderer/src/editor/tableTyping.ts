// Typing a table row by hand. Tab, Return and Insert Row leave the cursor in a new, empty row; someone who goes
// on typing `| 1 | 2 |` means its pipes as cell borders, not cell text. So on that row, while the cursor stays on it:
// - the first pipe typed while the row is empty is its opening pipe: the cursor goes to the start of the first cell;
// - a pipe at the end of a cell's text (or in an empty cell) goes to the start of the next cell, and from the last
//   cell past the closing pipe; the table is formatted as Tab formats it;
// - a space right after one of those pipes is the padding the table already has, and is dropped.
// Everything else is typed as written (a pipe inside a cell's text, after a backslash or the closing pipe; input
// while an input method composes or the completion list is open; other lines). A pipe joins its cell's undo step.
import { completionStatus } from '@codemirror/autocomplete'
import {
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { editorComposes } from '../ime'
import { escapedAt } from './table'
import {
  FIRST_ROW,
  enterEmptyRow,
  locate,
  rewrite,
  type Located,
  type Target,
} from './tableCommands'

interface RowTyping {
  from: number
  /** Whether a pipe typed while the row is empty is its opening pipe. */
  lead: boolean
  /** Whether a space typed now is padding after a pipe the rule just took. */
  space: boolean
}

const setRowTyping = StateEffect.define<Omit<RowTyping, 'from'>>()

const rowTyping = StateField.define<RowTyping | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRowTyping))
        return { from: tr.newDoc.lineAt(tr.newSelection.main.head).from, ...effect.value }
      if (effect.is(enterEmptyRow))
        return { from: tr.newDoc.line(effect.value).from, lead: true, space: false }
    }
    if (!value) return null
    // The row ends when its line does (joined to the one above) or the cursor leaves it.
    const from = tr.changes.mapPos(value.from, -1)
    const line = tr.newDoc.lineAt(from)
    const { ranges, main } = tr.newSelection
    if (line.from !== from || ranges.length > 1 || !main.empty) return null
    if (main.head < line.from || main.head > line.to) return null
    // A change from elsewhere (another window, the sync) is not the user's typing.
    if (tr.annotation(Transaction.userEvent) === undefined) return { ...value, from }
    // Undo goes back to an earlier row, maybe the empty one Return made.
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return { from, lead: true, space: false }
    // A pipe typed while the row is still empty (after a letter typed and
    // deleted, or a stray space) is still its opening pipe: only the rule
    // taking that pipe ends it.
    return { from, lead: value.lead, space: false }
  },
})

/**
 * The transaction for a pipe the rule takes: the table formatted, the cursor
 * where `target` says.
 */
function moveTo(
  state: EditorState,
  at: Located,
  target: Target,
  next: Omit<RowTyping, 'from'>,
): TransactionSpec {
  const { change, cursor } = rewrite(state, at, target)
  const head = state.selection.main.head
  const effects = setRowTyping.of(next)
  const selection = EditorSelection.cursor(cursor)
  if (!change) {
    if (cursor === head) return { effects }
    return { selection, effects, userEvent: 'select', scrollIntoView: true }
  }
  // Padding taken out of (or put into) the spaces after the typed text is
  // the same text wherever in them it goes: at the cursor, the change
  // touches the typing before it and joins its undo step.
  let { from, to } = change
  const blank = /^ *$/
  if (from > head && blank.test(state.doc.sliceString(head, to)) && blank.test(change.insert)) {
    to = head + (to - from)
    from = head
  }
  return {
    changes: { from, to, insert: change.insert },
    selection,
    effects,
    userEvent: 'input.type',
    scrollIntoView: true,
  }
}

/**
 * What typing `text` over `from`-`to` does on a row typed by hand: the
 * transaction to dispatch instead of the plain insertion, or null to type it
 * as written.
 */
export function typeInTable(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): TransactionSpec | null {
  const mode = state.field(rowTyping, false)
  if (!mode || (text !== '|' && text !== ' ')) return null
  const { ranges, main } = state.selection
  if (ranges.length > 1 || !main.empty || from !== main.head || to !== main.head) return null
  const line = state.doc.lineAt(main.head)
  if (line.from !== mode.from || completionStatus(state) === 'active') return null
  if (text === ' ')
    return mode.space ? { effects: setRowTyping.of({ lead: mode.lead, space: false }) } : null
  if (escapedAt(line.text, main.head - line.from)) return null
  const at = locate(state)
  if (!at || at.line < FIRST_ROW || at.rowEnd) return null
  const row = at.table.rows[at.line - FIRST_ROW]!
  // Inside the cell's text the pipe is text.
  if (at.offset < row[at.column]!.length) return null
  const next = { lead: false, space: true }
  if (mode.lead && row.every((cell) => cell === ''))
    return moveTo(state, at, { table: at.table, line: at.line, column: 0, offset: 0 }, next)
  if (at.column < at.table.align.length - 1) {
    const target = { table: at.table, line: at.line, column: at.column + 1, offset: 0 }
    return moveTo(state, at, target, next)
  }
  const target = { table: at.table, line: at.line, column: at.column, offset: 0, rowEnd: true }
  return moveTo(state, at, target, { ...next, space: false })
}

/** The editor's input handler for the rule; false leaves the input to the editor. */
export function tableInput(view: EditorView, from: number, to: number, text: string): boolean {
  if (editorComposes(view) || view.state.readOnly) return false
  const spec = typeInTable(view.state, from, to, text)
  if (!spec) return false
  view.dispatch(spec)
  return true
}

export function tableTyping(): Extension {
  return [rowTyping, EditorView.inputHandler.of(tableInput)]
}
