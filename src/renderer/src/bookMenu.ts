// The notebook context menu: a native menu with the notebook actions, and the
// keys that run some of them on the focused notebook row.
import type { KeyPress } from './commands/keys'
import type { ImportPick } from './importer'
import { commandMatches, type CommandId } from './commands/registry'
import { commandEntry, type CommandEntryOptions, type MenuGroups } from './contextMenu'

export type BookCommand =
  | 'copyId'
  | 'newInside'
  | 'openWorkspace'
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

export type ImportAction = 'importMarkdownFiles' | 'importMarkdownFolder' | 'importHtmlFiles'

export const IMPORT_PICKS: Readonly<Record<ImportAction, ImportPick>> = {
  importMarkdownFiles: 'markdownFiles',
  importMarkdownFolder: 'markdownFolders',
  importHtmlFiles: 'htmlFiles',
}

export type BookAction = BookCommand | 'import' | 'export'

export interface BookMenuTarget {
  id: string
  parentId: string | null
  aiAccess: boolean
  /** The sibling shown just above it (Move Up goes before it), if any. */
  previousId: string | null
  /** The sibling shown just below it (Move Down goes after it), if any. */
  nextId: string | null
}

export const BOOK_COMMANDS: Readonly<Record<BookCommand, CommandId>> = {
  copyId: 'notebook.copyId',
  newInside: 'notebook.newInside',
  openWorkspace: 'notebook.openWorkspace',
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

/**
 * Whether `action` applies to `book`: a key bound to an action the menu hides
 * for that notebook (Move to Top Level on a top-level one) does nothing.
 */
export function bookActionShown(action: BookAction, book: BookMenuTarget): boolean {
  for (const group of BOOK_MENU) {
    for (const entry of group) {
      if (entry.action === action) return entry.shown?.(book) ?? true
    }
  }
  return true
}

export const BOOK_MENU: MenuGroups<BookAction, BookMenuTarget> = [
  [entry('copyId'), entry('newInside')],
  [entry('openWorkspace')],
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
      edits: true,
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

export const WORKSPACE_ACTIONS = ['rename', 'changeIcon', 'copyId'] as const satisfies BookCommand[]

export const WORKSPACE_MENU: MenuGroups<BookAction, BookMenuTarget> = [
  [entry('rename'), entry('changeIcon')],
  [entry('copyId')],
]

/** The workspace title action a key press asks for, if any (Return renames, as on a row). */
export function workspaceShortcut(e: KeyPress): (typeof WORKSPACE_ACTIONS)[number] | undefined {
  return WORKSPACE_ACTIONS.find((action) => commandMatches(BOOK_COMMANDS[action], e))
}

export function bookShortcut(e: KeyPress): BookCommand | undefined {
  return (Object.keys(BOOK_COMMANDS) as BookCommand[]).find((action) =>
    commandMatches(BOOK_COMMANDS[action], e),
  )
}
