// The notebook context menu: a native menu with the notebook actions, and the
// keys that run some of them on the focused notebook row.
import type { KeyPress } from './commands/keys'
import { commandMatches, type CommandId } from './commands/registry'
import { commandEntry, type CommandEntryOptions, type MenuGroups } from './contextMenu'

export type BookAction =
  | 'newInside'
  | 'rename'
  | 'moveUp'
  | 'moveDown'
  | 'moveToTop'
  | 'aiAccess'
  | 'exportMarkdown'
  | 'exportHtml'
  | 'delete'

/** What the menu needs to know about the notebook that was right-clicked. */
export interface BookMenuTarget {
  id: string
  /** Its effective parent: null for a top-level notebook. */
  parentId: string | null
  /** Allow AI Access, which the menu shows checked and toggles. */
  aiAccess: boolean
  /** The sibling shown just above it (Move Up goes before it), if any. */
  previousId: string | null
  /** The sibling shown just below it (Move Down goes after it), if any. */
  nextId: string | null
}

/** The registry command behind each notebook action (its label and keys). */
export const BOOK_COMMANDS: Readonly<Record<BookAction, CommandId>> = {
  newInside: 'notebook.newInside',
  rename: 'notebook.rename',
  moveUp: 'notebook.moveUp',
  moveDown: 'notebook.moveDown',
  moveToTop: 'notebook.moveToTop',
  aiAccess: 'notebook.aiAccess',
  exportMarkdown: 'notebook.exportMarkdown',
  exportHtml: 'notebook.exportHtml',
  delete: 'notebook.delete',
}

const entry = (action: BookAction, more: CommandEntryOptions<BookAction, BookMenuTarget> = {}) =>
  commandEntry(action, BOOK_COMMANDS[action], more)

/** The menu's items, group by group; `bookShortcut` handles the keys shown. */
export const BOOK_MENU: MenuGroups<BookAction, BookMenuTarget> = [
  [entry('newInside')],
  [
    entry('rename'),
    entry('moveUp', { shown: (book) => book.previousId !== null }),
    entry('moveDown', { shown: (book) => book.nextId !== null }),
    entry('moveToTop', { shown: (book) => book.parentId !== null }),
  ],
  [entry('aiAccess', { checked: (book) => book.aiAccess })],
  [entry('exportMarkdown'), entry('exportHtml')],
  [entry('delete')],
]

/** The notebook action a key press on a notebook row asks for, if any. */
export function bookShortcut(e: KeyPress): BookAction | undefined {
  return (Object.keys(BOOK_COMMANDS) as BookAction[]).find((action) =>
    commandMatches(BOOK_COMMANDS[action], e),
  )
}
