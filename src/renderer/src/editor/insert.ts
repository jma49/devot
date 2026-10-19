// Insertions in the note editor: an image, a table and a note link. Like the
// formats, each turns an EditorState into one transaction (one Yjs update,
// one undo step), or null when nothing goes in there. The slash menu, the
// command palette and any keys the user gives them run them (the registry's
// `insert.*` commands).
import { startCompletion } from '@codemirror/autocomplete'
import { Prec, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { keymap, type Command, type EditorView } from '@codemirror/view'
import { editorInsertKeys } from '../commands/registry'
import type { FormatCommand } from './formatContext'
import { insertImage, insertNoteLink } from './formats'
import { registryKeys } from './registryKeys'
import { insertBlocks } from './rule'
import { printTable, type Table } from './table'

export { insertImage, insertNoteLink } from './formats'

export type InsertId = 'image' | 'table' | 'noteLink'

const NEW_TABLE: Table = { header: ['', ''], align: ['none', 'none'], rows: [['', '']] }

/**
 * Inserts an empty table after each line with a cursor, as a rule goes in
 * (see insertBlocks): in place of a blank line or an empty list item, in a
 * quote it stays in the quote, after a table or setext heading it goes after
 * the block, and in code, HTML and front matter nothing happens. Blank lines
 * keep it apart from text above (which would be its header) and below
 * (which would be a row). The cursor goes to the first header cell, where
 * Tab goes on.
 */
export function insertTable(state: EditorState): TransactionSpec | null {
  const printed = printTable(NEW_TABLE)
  const column = printed.cells[0]?.[0]?.from ?? 0
  return insertBlocks(state, () => ({ lines: printed.lines, cursor: { line: 0, column } }))
}

export const INSERT_COMMANDS: Record<InsertId, FormatCommand> = {
  image: insertImage,
  table: insertTable,
  noteLink: insertNoteLink,
}

/** What follows an insertion in the editor: after a note link, the `[[` popup opens. */
export const AFTER_INSERT: Partial<Record<InsertId, (view: EditorView) => void>> = {
  noteLink: (view) => void startCompletion(view),
}

export function insertCommand(id: InsertId): Command {
  return (view) => {
    const tr = INSERT_COMMANDS[id](view.state)
    if (!tr) return false
    view.dispatch(tr)
    AFTER_INSERT[id]?.(view)
    return true
  }
}

export const insertKeymap: () => Extension = registryKeys(() =>
  Prec.high(
    keymap.of(
      editorInsertKeys().map(({ insert, key }) => ({
        key,
        run: insertCommand(insert),
        preventDefault: true,
      })),
    ),
  ),
)
