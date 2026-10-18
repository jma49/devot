// The notebook context menu: a native menu with the notebook actions, and the
// keys that run some of them on the focused notebook row.
import type { KeyPress } from './commands/keys'
import type { ImportPick } from './importer'
import { commandMatches, type CommandId } from './commands/registry'
import { commandEntry, type CommandEntryOptions, type MenuGroups } from './contextMenu'

/** A notebook action that runs a registry command. */
export type BookCommand =
  | 'copyId'
  | 'newInside'
  | 'rename'
  | 'changeIcon'
  | 'move'
  | 'moveUp'
  | 'moveDown'
  | 'moveToTop'
  | 'aiAccess'
  | ImportAction
  | 'exportMarkdown'
  | 'exportHtml'
  | 'delete'

/** What the notebook's Import submenu picks; the import goes into that notebook. */
export type ImportAction = 'importMarkdownFiles' | 'importMarkdownFolder' | 'importHtmlFiles'

/** The panel each Import item opens (Rust's `Pick`). */
export const IMPORT_PICKS: Readonly<Record<ImportAction, ImportPick>> = {
  importMarkdownFiles: 'markdownFiles',
  importMarkdownFolder: 'markdownFolders',
  importHtmlFiles: 'htmlFiles',
}

/** Every menu action: the commands, and `import` and `export`, which only name submenus. */
export type BookAction = BookCommand | 'import' | 'export'

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
export const BOOK_COMMANDS: Readonly<Record<BookCommand, CommandId>> = {
  copyId: 'notebook.copyId',
  newInside: 'notebook.newInside',
  rename: 'notebook.rename',
  changeIcon: 'notebook.changeIcon',
  move: 'notebook.move',
  moveUp: 'notebook.moveUp',
  moveDown: 'notebook.moveDown',
  moveToTop: 'notebook.moveToTop',
  aiAccess: 'notebook.aiAccess',
  importMarkdownFiles: 'notebook.importMarkdownFiles',
  importMarkdownFolder: 'notebook.importMarkdownFolder',
  importHtmlFiles: 'notebook.importHtmlFiles',
  exportMarkdown: 'notebook.exportMarkdown',
  exportHtml: 'notebook.exportHtml',
  delete: 'notebook.delete',
}

const entry = (action: BookCommand, more: CommandEntryOptions<BookAction, BookMenuTarget> = {}) =>
  commandEntry<BookAction, BookMenuTarget>(action, BOOK_COMMANDS[action], more)

/** The menu's items, group by group; `bookShortcut` handles the keys shown. */
export const BOOK_MENU: MenuGroups<BookAction, BookMenuTarget> = [
  [entry('copyId'), entry('newInside')],
  [
    entry('rename'),
    entry('changeIcon'),
    entry('move'),
    entry('moveUp', { shown: (book) => book.previousId !== null }),
    entry('moveDown', { shown: (book) => book.nextId !== null }),
    entry('moveToTop', { shown: (book) => book.parentId !== null }),
  ],
  [entry('aiAccess', { checked: (book) => book.aiAccess })],
  [
    {
      action: 'import',
      label: 'bookMenu.import',
      submenu: [
        entry('importMarkdownFiles', { label: 'bookMenu.importMarkdownFilesItem' }),
        entry('importMarkdownFolder', { label: 'bookMenu.importMarkdownFolderItem' }),
        entry('importHtmlFiles', { label: 'bookMenu.importHtmlFilesItem' }),
      ],
    },
    {
      action: 'export',
      label: 'bookMenu.export',
      submenu: [
        entry('exportMarkdown', { label: 'bookMenu.exportMarkdownItem' }),
        entry('exportHtml', { label: 'bookMenu.exportHtmlItem' }),
      ],
    },
  ],
  [entry('delete')],
]

/** The notebook action a key press on a notebook row asks for, if any. */
export function bookShortcut(e: KeyPress): BookCommand | undefined {
  return (Object.keys(BOOK_COMMANDS) as BookCommand[]).find((action) =>
    commandMatches(BOOK_COMMANDS[action], e),
  )
}
