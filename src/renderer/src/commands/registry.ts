// The command registry: every app command is declared here once, with its
// catalog label, its group, where its keys work (its scope) and its default
// keys (see `keys.ts`). Window shortcuts, find, the note status keys, the
// note list, Trash, notebook and tag row keys, the context menus'
// accelerators, the editor's format and find keymaps and the command palette
// all read their keys from it (`commandKeys`: the defaults declared here with
// the user's changes, see keymap.ts). The window binds a handler to each
// command it can run (`CommandHandlers`); a command without one is not offered.
import type { FormatId } from '../editor/formats'
import type { InsertId } from '../editor/insert'
import type { TableCommandId } from '../editor/tableCommands'
import type { MessageKey } from '../i18n'
import { keyMatches, shortcutAccelerator, shortcutCodeMirror, type KeyPress } from './keys'

/**
 * Where a command's keys work. Scopes nest (see `SCOPE_PARENT`):
 * - `window`: everywhere in the window, the editor too;
 * - `editor`: the note editor;
 * - `outsideEditor`: the window but not the editor;
 * - `panes`: the sidebar's rows and the note list (not toolbars or fields);
 * - `sidebar`: a row in the sidebar;
 * - `list`: any note list, the Trash's too;
 * - `noteList`: the note list of the library or of search results;
 * - `trashList`: the note list in the Trash;
 * - `notebookRow`, `tagRow`: a notebook or tag row in the sidebar;
 * - `sidebarRow`: any other sidebar row (All Notes, Pinned, a status,
 *   Templates, the Trash, a workspace's title).
 */
export type CommandScope =
  | 'window'
  | 'editor'
  | 'outsideEditor'
  | 'panes'
  | 'sidebar'
  | 'list'
  | 'noteList'
  | 'trashList'
  | 'notebookRow'
  | 'tagRow'
  | 'sidebarRow'

/** The scope each scope lies within; keys of a scope also work in its parent. */
const SCOPE_PARENT: Readonly<Record<CommandScope, CommandScope | null>> = {
  window: null,
  editor: 'window',
  outsideEditor: 'window',
  panes: 'outsideEditor',
  sidebar: 'panes',
  list: 'panes',
  noteList: 'list',
  trashList: 'list',
  notebookRow: 'sidebar',
  tagRow: 'sidebar',
  sidebarRow: 'sidebar',
}

/** How commands are grouped (for a shortcuts list, and the palette's order). */
export type CommandGroup =
  | 'note'
  | 'notebook'
  | 'tag'
  | 'view'
  | 'search'
  | 'find'
  | 'edit'
  | 'format'
  | 'table'
  | 'image'
  | 'app'

export interface CommandSpec {
  readonly id: string
  readonly label: MessageKey
  readonly group: CommandGroup
  readonly scope: CommandScope
  /** Default keys in canonical form; the first is the one shown. */
  readonly keys: readonly string[]
  /** False: never listed in the palette (opening the palette, sidebar row keys). */
  readonly palette?: false
}

export const COMMANDS = [
  // The window.
  {
    id: 'palette.open',
    label: 'command.palette',
    group: 'app',
    scope: 'window',
    keys: ['Mod+K'],
    palette: false,
  },
  { id: 'note.new', label: 'noteList.newNote', group: 'note', scope: 'window', keys: ['Mod+N'] },
  // Moving between notes. Back and Forward follow the notes this window
  // opened; Next and Previous follow the note list. Cmd+[ and Cmd+] work
  // everywhere, the editor too (it indents and outdents with Tab and
  // Shift+Tab); the arrow keys work only while no text field has the focus,
  // where they move the caret (see dispatch.ts and editor/settings.ts).
  {
    id: 'note.back',
    label: 'command.back',
    group: 'note',
    scope: 'window',
    keys: ['Mod+[', 'Mod+ArrowLeft'],
  },
  {
    id: 'note.forward',
    label: 'command.forward',
    group: 'note',
    scope: 'window',
    keys: ['Mod+]', 'Mod+ArrowRight'],
  },
  {
    id: 'note.next',
    label: 'command.nextNote',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Shift+]'],
  },
  {
    id: 'note.previous',
    label: 'command.previousNote',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Shift+['],
  },
  // In the note list: Return edits the open note's title, Cmd+Return its body.
  {
    id: 'note.editTitle',
    label: 'command.editTitle',
    group: 'note',
    scope: 'noteList',
    keys: ['Enter'],
    palette: false,
  },
  {
    id: 'note.editBody',
    label: 'command.editBody',
    group: 'note',
    scope: 'noteList',
    keys: ['Mod+Enter'],
    palette: false,
  },
  {
    id: 'note.newFromTemplate',
    label: 'command.newFromTemplate',
    group: 'note',
    scope: 'window',
    keys: ['Mod+T'],
  },
  {
    id: 'note.history',
    label: 'noteMenu.history',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Alt+Y'],
  },
  // The open note; the keys work in the note list.
  { id: 'note.move', label: 'noteMenu.move', group: 'note', scope: 'noteList', keys: ['M'] },
  // The same from anywhere, the editor too (the list's own key is a plain M).
  {
    id: 'note.moveAnywhere',
    label: 'noteMenu.move',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Ctrl+M'],
    palette: false,
  },
  {
    id: 'note.duplicate',
    label: 'noteMenu.duplicate',
    group: 'note',
    scope: 'noteList',
    keys: ['Mod+D'],
  },
  { id: 'note.pin', label: 'note.pin', group: 'note', scope: 'noteList', keys: ['P'] },
  {
    id: 'note.copyLink',
    label: 'noteMenu.copyLink',
    group: 'note',
    scope: 'noteList',
    keys: ['Mod+C'],
  },
  {
    id: 'note.copyUri',
    label: 'noteMenu.copyUri',
    group: 'note',
    scope: 'noteList',
    keys: ['Mod+Shift+C'],
  },
  { id: 'note.copyId', label: 'noteMenu.copyId', group: 'note', scope: 'noteList', keys: [] },
  // Export and print the open note (exporter.ts). Print has the window-wide
  // Shift+Cmd+P: Cmd+P is the command palette.
  {
    id: 'note.exportHtml',
    label: 'noteMenu.exportHtml',
    group: 'note',
    scope: 'noteList',
    keys: [],
  },
  { id: 'note.copyHtml', label: 'noteMenu.copyHtml', group: 'note', scope: 'noteList', keys: [] },
  {
    id: 'note.copySimpleHtml',
    label: 'noteMenu.copySimpleHtml',
    group: 'note',
    scope: 'noteList',
    keys: [],
  },
  {
    id: 'note.exportMarkdown',
    label: 'noteMenu.exportMarkdown',
    group: 'note',
    scope: 'noteList',
    keys: [],
  },
  {
    id: 'note.exportPdf',
    label: 'noteMenu.exportPdf',
    group: 'note',
    scope: 'noteList',
    keys: [],
  },
  {
    id: 'note.print',
    label: 'noteMenu.print',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Shift+P'],
  },
  {
    id: 'note.trash',
    label: 'note.moveToTrash',
    group: 'note',
    scope: 'noteList',
    keys: ['Mod+Backspace'],
  },
  // Tags for the notes selected in the list (see SelectionSummary); offered
  // only while several notes are selected.
  {
    id: 'note.addTag',
    label: 'batch.addTag',
    group: 'note',
    scope: 'noteList',
    keys: [],
  },
  {
    id: 'note.removeTag',
    label: 'batch.removeTag',
    group: 'note',
    scope: 'noteList',
    keys: [],
  },
  // Selecting several notes in a list (the Trash's too): Shift+Up and
  // Shift+Down extend the selection, Cmd+A selects every note listed (in the
  // editor it stays Select All for the text), Escape goes back to the open
  // note alone.
  {
    id: 'list.selectAll',
    label: 'command.selectAllNotes',
    group: 'note',
    scope: 'list',
    keys: ['Mod+A'],
  },
  {
    id: 'list.clearSelection',
    label: 'command.clearSelection',
    group: 'note',
    scope: 'list',
    keys: ['Escape'],
    palette: false,
  },
  {
    id: 'list.extendUp',
    label: 'command.extendSelectionUp',
    group: 'note',
    scope: 'list',
    keys: ['Shift+ArrowUp'],
    palette: false,
  },
  {
    id: 'list.extendDown',
    label: 'command.extendSelectionDown',
    group: 'note',
    scope: 'list',
    keys: ['Shift+ArrowDown'],
    palette: false,
  },
  // The Trash: the open (trashed) note; the keys work in the Trash's list.
  {
    id: 'trash.restore',
    label: 'command.restoreFromTrash',
    group: 'note',
    scope: 'trashList',
    keys: [],
  },
  {
    id: 'trash.deleteForever',
    label: 'trash.deleteForever',
    group: 'note',
    scope: 'trashList',
    keys: ['Mod+Backspace'],
  },
  { id: 'trash.empty', label: 'trash.empty', group: 'note', scope: 'window', keys: [] },
  // The open note's status (see statusKeys.ts); the keys work everywhere, the
  // editor too, so they take a chord nothing else uses.
  {
    id: 'status.none',
    label: 'command.statusNone',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Ctrl+1'],
  },
  {
    id: 'status.active',
    label: 'command.statusActive',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Ctrl+2'],
  },
  {
    id: 'status.onHold',
    label: 'command.statusOnHold',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Ctrl+3'],
  },
  {
    id: 'status.completed',
    label: 'command.statusCompleted',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Ctrl+4'],
  },
  {
    id: 'status.dropped',
    label: 'command.statusDropped',
    group: 'note',
    scope: 'window',
    keys: ['Mod+Ctrl+5'],
  },
  { id: 'notebook.new', label: 'book.new', group: 'notebook', scope: 'window', keys: [] },
  // Shows the open note's notebook in the sidebar (the note header's notebook menu).
  {
    id: 'note.showNotebook',
    label: 'command.showNotebook',
    group: 'notebook',
    scope: 'window',
    keys: [],
  },
  // A notebook or tag row in the sidebar: its own menu (every action of the
  // row, the notebook's export and Allow AI Access and the tag's colours
  // too) opens at the row, from the keyboard. Shift+F10 and the menu key as
  // on other systems; Control+Return as in Mac text fields.
  {
    id: 'sidebar.rowMenu',
    label: 'command.rowMenu',
    group: 'app',
    scope: 'sidebar',
    keys: ['Shift+F10', 'ContextMenu', 'Ctrl+Enter'],
    palette: false,
  },
  // A notebook row in the sidebar.
  {
    id: 'notebook.newInside',
    label: 'bookMenu.newInside',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.openWorkspace',
    label: 'bookMenu.openWorkspace',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.copyId',
    label: 'bookMenu.copyId',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.move',
    label: 'bookMenu.move',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.rename',
    label: 'bookMenu.rename',
    group: 'notebook',
    scope: 'notebookRow',
    keys: ['Enter', 'F2'],
    palette: false,
  },
  {
    id: 'notebook.changeIcon',
    label: 'bookMenu.changeIcon',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.moveUp',
    label: 'bookMenu.moveUp',
    group: 'notebook',
    scope: 'notebookRow',
    keys: ['Alt+ArrowUp'],
    palette: false,
  },
  {
    id: 'notebook.moveDown',
    label: 'bookMenu.moveDown',
    group: 'notebook',
    scope: 'notebookRow',
    keys: ['Alt+ArrowDown'],
    palette: false,
  },
  {
    id: 'notebook.moveToTop',
    label: 'bookMenu.moveToTop',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.aiAccess',
    label: 'bookMenu.aiAccess',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.importMarkdownFiles',
    label: 'bookMenu.importMarkdownFiles',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.importMarkdownFolder',
    label: 'bookMenu.importMarkdownFolder',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.importHtmlFiles',
    label: 'bookMenu.importHtmlFiles',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.exportMarkdown',
    label: 'bookMenu.exportMarkdown',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.exportHtml',
    label: 'bookMenu.exportHtml',
    group: 'notebook',
    scope: 'notebookRow',
    keys: [],
    palette: false,
  },
  {
    id: 'notebook.delete',
    label: 'bookMenu.delete',
    group: 'notebook',
    scope: 'notebookRow',
    keys: ['Backspace', 'Delete'],
    palette: false,
  },
  // In a workspace: up to the parent notebook's workspace, or out of
  // workspaces at the top level. Backspace on the rows where it deletes
  // nothing; Command+Up (the enclosing folder) on every row.
  {
    id: 'sidebar.workspaceUp',
    label: 'command.workspaceUp',
    group: 'view',
    scope: 'sidebarRow',
    keys: ['Backspace'],
    palette: false,
  },
  {
    id: 'sidebar.workspaceUpFromAnyRow',
    label: 'command.workspaceUp',
    group: 'view',
    scope: 'sidebar',
    keys: ['Mod+ArrowUp'],
    palette: false,
  },
  // A tag row in the sidebar.
  {
    id: 'tag.rename',
    label: 'tagMenu.rename',
    group: 'tag',
    scope: 'tagRow',
    keys: ['F2'],
    palette: false,
  },
  {
    id: 'tag.settings',
    label: 'tagMenu.settings',
    group: 'tag',
    scope: 'tagRow',
    keys: [],
    palette: false,
  },
  {
    id: 'tag.filter',
    label: 'tagMenu.filter',
    group: 'tag',
    scope: 'tagRow',
    keys: [],
    palette: false,
  },
  {
    id: 'tag.copyId',
    label: 'tagMenu.copyId',
    group: 'tag',
    scope: 'tagRow',
    keys: [],
    palette: false,
  },
  {
    id: 'tag.delete',
    label: 'tagMenu.delete',
    group: 'tag',
    scope: 'tagRow',
    keys: ['Backspace', 'Delete'],
    palette: false,
  },
  // Views.
  {
    id: 'view.allNotes',
    label: 'command.showAllNotes',
    group: 'view',
    scope: 'window',
    keys: [],
  },
  {
    id: 'view.templates',
    label: 'command.showTemplates',
    group: 'view',
    scope: 'window',
    keys: [],
  },
  { id: 'view.trash', label: 'command.showTrash', group: 'view', scope: 'window', keys: [] },
  {
    id: 'view.leaveWorkspace',
    label: 'command.leaveWorkspace',
    group: 'view',
    scope: 'window',
    keys: [],
  },
  { id: 'view.edit', label: 'command.modeEdit', group: 'view', scope: 'window', keys: [] },
  {
    id: 'view.togglePreview',
    label: 'command.modeToggle',
    group: 'view',
    scope: 'window',
    keys: ['Mod+E'],
  },
  {
    id: 'view.split',
    label: 'command.modeSplit',
    group: 'view',
    scope: 'window',
    keys: ['Mod+P'],
  },
  { id: 'view.preview', label: 'command.modePreview', group: 'view', scope: 'window', keys: [] },
  // Split mode: the editor and the preview scroll together (an editor
  // setting; also View > Synced Scrolling in the menu bar).
  {
    id: 'view.syncScroll',
    label: 'command.syncScrollOn',
    group: 'view',
    scope: 'window',
    keys: [],
  },
  // The note list's date style (an editor setting; also in the sort pop-up).
  {
    id: 'view.toggleListDates',
    label: 'command.showAbsoluteDates',
    group: 'view',
    scope: 'window',
    keys: [],
  },
  { id: 'view.focus', label: 'mode.focus', group: 'view', scope: 'window', keys: ['Mod+Shift+D'] },
  // The note list's sort pop-up, from the palette (its button is not a Tab stop).
  { id: 'view.sort', label: 'command.sort', group: 'view', scope: 'window', keys: [] },
  // Also View > Hide Sidebar in the menu bar; the label follows the state.
  {
    id: 'view.sidebar',
    label: 'command.hideSidebar',
    group: 'view',
    scope: 'window',
    keys: ['Mod+/'],
  },
  // The keyboard moves between the sidebar, the note list and the editor:
  // Tab and Shift+Tab on a sidebar row or in the list; Control+Tab and
  // Control+Shift+Tab anywhere, the editor too, where Tab indents and moves
  // between table cells (see areas.ts).
  {
    id: 'view.nextAreaInPane',
    label: 'command.nextArea',
    group: 'view',
    scope: 'panes',
    keys: ['Tab'],
    palette: false,
  },
  {
    id: 'view.previousAreaInPane',
    label: 'command.previousArea',
    group: 'view',
    scope: 'panes',
    keys: ['Shift+Tab'],
    palette: false,
  },
  {
    id: 'view.nextArea',
    label: 'command.nextArea',
    group: 'view',
    scope: 'window',
    keys: ['Ctrl+Tab'],
    palette: false,
  },
  {
    id: 'view.previousArea',
    label: 'command.previousArea',
    group: 'view',
    scope: 'window',
    keys: ['Ctrl+Shift+Tab'],
    palette: false,
  },
  // The editor's font size (Settings > Editing), in every window that shows
  // notes. Cmd+= with or without Shift, as Cmd++ is typed.
  {
    id: 'view.fontBigger',
    label: 'command.fontBigger',
    group: 'view',
    scope: 'window',
    keys: ['Mod+=', 'Mod+Shift+='],
  },
  {
    id: 'view.fontSmaller',
    label: 'command.fontSmaller',
    group: 'view',
    scope: 'window',
    keys: ['Mod+-'],
  },
  {
    id: 'view.fontReset',
    label: 'command.fontReset',
    group: 'view',
    scope: 'window',
    keys: ['Mod+0'],
  },
  // Search.
  {
    id: 'search.view',
    label: 'command.searchView',
    group: 'search',
    scope: 'window',
    keys: ['Mod+Shift+F'],
  },
  {
    id: 'search.all',
    label: 'command.searchAll',
    group: 'search',
    scope: 'window',
    keys: ['Mod+Alt+Shift+F'],
  },
  // `/` in a note list: search the view it shows (every note from the Trash).
  {
    id: 'search.fromList',
    label: 'command.searchFromList',
    group: 'search',
    scope: 'list',
    keys: ['/'],
    palette: false,
  },
  // Find in the open note (see find/useFind.tsx): window-wide while a note
  // is open, ahead of the editor's own keys. Regular Expression and Match
  // Case only act while the find bar is open.
  { id: 'find.find', label: 'find.label', group: 'find', scope: 'window', keys: ['Mod+F'] },
  {
    id: 'find.replace',
    label: 'command.findReplace',
    group: 'find',
    scope: 'window',
    keys: ['Mod+Alt+F'],
  },
  { id: 'find.next', label: 'find.next', group: 'find', scope: 'window', keys: ['Mod+G'] },
  {
    id: 'find.previous',
    label: 'find.previous',
    group: 'find',
    scope: 'window',
    keys: ['Mod+Shift+G'],
  },
  {
    id: 'find.regexp',
    label: 'find.regexp',
    group: 'find',
    scope: 'window',
    keys: ['Mod+Alt+R'],
  },
  {
    id: 'find.caseSensitive',
    label: 'find.matchCase',
    group: 'find',
    scope: 'window',
    keys: ['Mod+Alt+C'],
  },
  // In the editor, with the find bar open, F3 steps through the matches too
  // (editor/find.ts).
  {
    id: 'find.nextInEditor',
    label: 'find.next',
    group: 'find',
    scope: 'editor',
    keys: ['F3'],
    palette: false,
  },
  {
    id: 'find.previousInEditor',
    label: 'find.previous',
    group: 'find',
    scope: 'editor',
    keys: ['Shift+F3'],
    palette: false,
  },
  // Formats in the note editor (see editor/formats.ts).
  {
    id: 'format.heading1',
    label: 'command.heading1',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+1'],
  },
  {
    id: 'format.heading2',
    label: 'command.heading2',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+2'],
  },
  {
    id: 'format.heading3',
    label: 'command.heading3',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+3'],
  },
  {
    id: 'format.heading4',
    label: 'command.heading4',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+4'],
  },
  {
    id: 'format.heading5',
    label: 'command.heading5',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Alt+5'],
  },
  {
    id: 'format.heading6',
    label: 'command.heading6',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Alt+6'],
  },
  {
    id: 'format.headingBigger',
    label: 'command.headingBigger',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'format.headingSmaller',
    label: 'command.headingSmaller',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  { id: 'format.bold', label: 'format.bold', group: 'format', scope: 'editor', keys: ['Mod+B'] },
  {
    id: 'format.italic',
    label: 'format.italic',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+I'],
  },
  {
    id: 'format.strikethrough',
    label: 'format.strikethrough',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+U'],
  },
  {
    id: 'format.highlight',
    label: 'format.highlight',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'format.link',
    label: 'format.link',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Alt+K'],
  },
  {
    id: 'format.code',
    label: 'format.code',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Alt+E'],
  },
  // Shift+Cmd+C is also Copy Note URI, but only on a note list row: the
  // editor never sees that key there, nor the list here.
  {
    id: 'format.codeBlock',
    label: 'format.codeBlock',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Shift+C'],
  },
  {
    id: 'format.bulletList',
    label: 'format.bulletList',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Shift+L'],
  },
  {
    id: 'format.numberedList',
    label: 'format.numberedList',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Shift+O'],
  },
  {
    id: 'format.taskList',
    label: 'format.taskList',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Shift+T'],
  },
  {
    id: 'format.quote',
    label: 'format.quote',
    group: 'format',
    scope: 'editor',
    keys: ["Mod+'"],
  },
  {
    id: 'format.horizontalRule',
    label: 'format.horizontalRule',
    group: 'format',
    scope: 'editor',
    keys: ['Mod+Shift+H'],
  },
  // Alerts have no keys: the toolbar's Alert pop-up and the palette pick them.
  {
    id: 'format.alertNote',
    label: 'command.alertNote',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  { id: 'format.alertTip', label: 'command.alertTip', group: 'format', scope: 'editor', keys: [] },
  {
    id: 'format.alertImportant',
    label: 'command.alertImportant',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'format.alertWarning',
    label: 'command.alertWarning',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'format.alertCaution',
    label: 'command.alertCaution',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  // Insertions in the note editor (see editor/insert.ts). They have no keys:
  // the slash menu (editor/slashMenu.ts) and the palette offer them.
  {
    id: 'insert.image',
    label: 'command.insertImage',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'insert.table',
    label: 'command.insertTable',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'insert.noteLink',
    label: 'command.insertNoteLink',
    group: 'format',
    scope: 'editor',
    keys: [],
  },
  // The selection becomes a new note, linked from where it was (App's
  // noteFromSelection, editor/extract.ts); the palette offers it while text
  // is selected.
  {
    id: 'note.newFromSelection',
    label: 'command.newNoteFromSelection',
    group: 'note',
    scope: 'editor',
    keys: [],
  },
  // The link at the caret becomes a new note titled after its text, linked
  // from where the link was (App's noteFromLink, editor/extract.ts); the
  // palette offers it while the caret is on a link.
  {
    id: 'note.newFromLink',
    label: 'command.newNoteFromLink',
    group: 'note',
    scope: 'editor',
    keys: [],
  },
  // Closes the open note (or the multiple selection, or the template shown):
  // the editor is left empty.
  {
    id: 'note.close',
    label: 'command.closeNote',
    group: 'note',
    scope: 'window',
    keys: [],
  },
  // Pastes the clipboard's text as it is: no link, no image (editor/paste.ts).
  {
    id: 'edit.pastePlain',
    label: 'command.pastePlainText',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Alt+Shift+V'],
  },
  // Opens the paste chooser for the clipboard's URL, or for the link at the
  // caret (editor/pasteChooser.ts).
  {
    id: 'edit.pasteUrlAs',
    label: 'command.pasteUrlAs',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  // Tables in the note editor (see editor/tableCommands.ts). Their keys act
  // only while the cursor is in a table; elsewhere Tab, Return and the rest
  // keep doing what they do in the editor. The palette lists the commands
  // only while the cursor is in a table.
  {
    id: 'table.nextCell',
    label: 'command.tableNextCell',
    group: 'table',
    scope: 'editor',
    keys: ['Tab'],
    palette: false,
  },
  {
    id: 'table.previousCell',
    label: 'command.tablePreviousCell',
    group: 'table',
    scope: 'editor',
    keys: ['Shift+Tab'],
    palette: false,
  },
  {
    id: 'table.nextRow',
    label: 'command.tableNextRow',
    group: 'table',
    scope: 'editor',
    keys: ['Enter'],
    palette: false,
  },
  {
    id: 'table.insertRowBelow',
    label: 'command.tableInsertRowBelow',
    group: 'table',
    scope: 'editor',
    keys: ['Alt+Enter'],
  },
  {
    id: 'table.insertRowAbove',
    label: 'command.tableInsertRowAbove',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.deleteRow',
    label: 'command.tableDeleteRow',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.moveRowUp',
    label: 'command.tableMoveRowUp',
    group: 'table',
    scope: 'editor',
    keys: ['Mod+Alt+Shift+ArrowUp'],
  },
  {
    id: 'table.moveRowDown',
    label: 'command.tableMoveRowDown',
    group: 'table',
    scope: 'editor',
    keys: ['Mod+Alt+Shift+ArrowDown'],
  },
  {
    id: 'table.insertColumnLeft',
    label: 'command.tableInsertColumnLeft',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.insertColumnRight',
    label: 'command.tableInsertColumnRight',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.deleteColumn',
    label: 'command.tableDeleteColumn',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.moveColumnLeft',
    label: 'command.tableMoveColumnLeft',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.moveColumnRight',
    label: 'command.tableMoveColumnRight',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'table.alignLeft',
    label: 'command.tableAlignLeft',
    group: 'table',
    scope: 'editor',
    keys: ['Mod+Alt+ArrowLeft'],
  },
  {
    id: 'table.alignCenter',
    label: 'command.tableAlignCenter',
    group: 'table',
    scope: 'editor',
    keys: ['Mod+Alt+ArrowUp'],
  },
  {
    id: 'table.alignRight',
    label: 'command.tableAlignRight',
    group: 'table',
    scope: 'editor',
    keys: ['Mod+Alt+ArrowRight'],
  },
  {
    id: 'table.alignNone',
    label: 'command.tableAlignNone',
    group: 'table',
    scope: 'editor',
    keys: ['Mod+Alt+ArrowDown'],
  },
  {
    id: 'table.format',
    label: 'command.tableFormat',
    group: 'table',
    scope: 'editor',
    keys: [],
  },
  // Images in the note editor (see imageMenu.ts): they act on the image at
  // the cursor, or on the one right-clicked when run from the image context
  // menu. The palette lists them only while the cursor is on a line with an
  // image (the copy and save commands only for an attachment).
  // View Image opens the viewer (what a double-click on the image does).
  { id: 'image.view', label: 'command.imageView', group: 'image', scope: 'editor', keys: [] },
  { id: 'image.copy', label: 'command.imageCopy', group: 'image', scope: 'editor', keys: [] },
  { id: 'image.save', label: 'command.imageSave', group: 'image', scope: 'editor', keys: [] },
  {
    id: 'image.sizeAuto',
    label: 'command.imageSizeAuto',
    group: 'image',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'image.sizeSmall',
    label: 'command.imageSizeSmall',
    group: 'image',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'image.sizeHalf',
    label: 'command.imageSizeHalf',
    group: 'image',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'image.sizeFull',
    label: 'command.imageSizeFull',
    group: 'image',
    scope: 'editor',
    keys: [],
  },
  // The app.
  // Keys added with the editing keys (kept together): the note list and the
  // sidebar rows from anywhere, and the editor's line commands (see
  // editor/lineCommands.ts). Return continues list and quote markup; Shift+Return
  // starts a plain line.
  {
    id: 'view.focusNoteList',
    label: 'command.focusNoteList',
    group: 'view',
    scope: 'window',
    keys: ['Mod+Ctrl+L'],
  },
  {
    id: 'view.nextSidebarRow',
    label: 'command.nextSidebarRow',
    group: 'view',
    scope: 'window',
    keys: ['Mod+Shift+J'],
  },
  {
    id: 'view.previousSidebarRow',
    label: 'command.previousSidebarRow',
    group: 'view',
    scope: 'window',
    keys: ['Mod+Shift+K'],
  },
  {
    id: 'edit.plainNewline',
    label: 'command.plainNewline',
    group: 'edit',
    scope: 'editor',
    keys: ['Shift+Enter'],
    palette: false,
  },
  {
    id: 'edit.lineBelow',
    label: 'command.lineBelow',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Enter'],
  },
  {
    id: 'edit.lineAbove',
    label: 'command.lineAbove',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Shift+Enter'],
  },
  {
    id: 'edit.deleteLine',
    label: 'command.deleteLine',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+D'],
  },
  {
    id: 'edit.selectLine',
    label: 'command.selectLine',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+L'],
  },
  {
    id: 'edit.moveLineUp',
    label: 'command.moveLineUp',
    group: 'edit',
    scope: 'editor',
    keys: ['Alt+ArrowUp'],
  },
  {
    id: 'edit.moveLineDown',
    label: 'command.moveLineDown',
    group: 'edit',
    scope: 'editor',
    keys: ['Alt+ArrowDown'],
  },
  {
    id: 'edit.copyLineUp',
    label: 'command.copyLineUp',
    group: 'edit',
    scope: 'editor',
    keys: ['Alt+Shift+ArrowUp'],
  },
  {
    id: 'edit.copyLineDown',
    label: 'command.copyLineDown',
    group: 'edit',
    scope: 'editor',
    keys: ['Alt+Shift+ArrowDown'],
  },
  // Indent and Outdent have no keys of their own: in the editor Tab and
  // Shift+Tab indent and outdent (a list item takes its marker along; in a
  // table they move between cells, in a code block Tab inserts the indent
  // unit), so Cmd+[ and Cmd+] stay Back and Forward (see note.back).
  {
    id: 'edit.outdent',
    label: 'command.outdent',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'edit.indent',
    label: 'command.indent',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'edit.openLink',
    label: 'command.openLink',
    group: 'edit',
    scope: 'editor',
    keys: ['Ctrl+Shift+O'],
  },
  // The editor's menu opens at the caret, from the keyboard (the same keys
  // as a row's menu in the sidebar, whose scope is a sibling of the editor's).
  {
    id: 'edit.contextMenu',
    label: 'command.editorMenu',
    group: 'edit',
    scope: 'editor',
    keys: ['Shift+F10', 'ContextMenu'],
    palette: false,
  },
  {
    id: 'edit.sortLines',
    label: 'command.sortLines',
    group: 'edit',
    scope: 'editor',
    keys: ['F5'],
  },
  {
    id: 'edit.sortLinesReverse',
    label: 'command.sortLinesReverse',
    group: 'edit',
    scope: 'editor',
    keys: ['Shift+F5'],
  },
  {
    id: 'edit.sortLinesCase',
    label: 'command.sortLinesCase',
    group: 'edit',
    scope: 'editor',
    keys: ['Ctrl+F5'],
  },
  {
    id: 'edit.sortLinesCaseReverse',
    label: 'command.sortLinesCaseReverse',
    group: 'edit',
    scope: 'editor',
    keys: ['Ctrl+Shift+F5'],
  },
  {
    id: 'edit.joinLines',
    label: 'command.joinLines',
    group: 'edit',
    scope: 'editor',
    keys: ['Ctrl+J'],
  },
  // More cursors and selections (Cmd+D stays Delete Line).
  {
    id: 'edit.addCursorAbove',
    label: 'command.addCursorAbove',
    group: 'edit',
    scope: 'editor',
    keys: ['Ctrl+Shift+ArrowUp'],
  },
  {
    id: 'edit.addCursorBelow',
    label: 'command.addCursorBelow',
    group: 'edit',
    scope: 'editor',
    keys: ['Ctrl+Shift+ArrowDown'],
  },
  {
    id: 'edit.selectNextOccurrence',
    label: 'command.selectNextOccurrence',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Alt+G'],
  },
  {
    id: 'edit.skipNextOccurrence',
    label: 'command.skipNextOccurrence',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Alt+Shift+G'],
  },
  {
    id: 'edit.selectAllMatches',
    label: 'command.selectAllMatches',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Ctrl+G'],
  },
  {
    id: 'edit.splitSelectionIntoLines',
    label: 'command.splitSelectionIntoLines',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Alt+L'],
  },
  {
    id: 'edit.undoSelection',
    label: 'command.undoSelection',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Alt+U'],
  },
  {
    id: 'edit.redoSelection',
    label: 'command.redoSelection',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Shift+U'],
  },
  {
    id: 'edit.goToBracket',
    label: 'command.goToBracket',
    group: 'edit',
    scope: 'editor',
    keys: ['Mod+Shift+\\'],
  },
  {
    id: 'edit.selectToBracket',
    label: 'command.selectToBracket',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'edit.upperCase',
    label: 'command.upperCase',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'edit.lowerCase',
    label: 'command.lowerCase',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  {
    id: 'edit.toggleTask',
    label: 'command.toggleTask',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  // Opens the palette at Go to Line: from anywhere in the window while a
  // note is open for editing (the line is the open note's).
  {
    id: 'edit.goToLine',
    label: 'command.goToLine',
    group: 'edit',
    scope: 'window',
    keys: ['Ctrl+G'],
  },
  // Typed text replaces the characters after the caret (editor/overwrite.ts).
  {
    id: 'edit.toggleOverwrite',
    label: 'command.toggleOverwrite',
    group: 'edit',
    scope: 'editor',
    keys: [],
  },
  { id: 'app.backups', label: 'command.backups', group: 'app', scope: 'window', keys: [] },
  // File > Export > All Notes (exporter.ts).
  {
    id: 'app.exportAllMarkdown',
    label: 'command.exportAllMarkdown',
    group: 'app',
    scope: 'window',
    keys: [],
  },
  {
    id: 'app.exportAllHtml',
    label: 'command.exportAllHtml',
    group: 'app',
    scope: 'window',
    keys: [],
  },
  {
    id: 'app.rebuildSearchIndex',
    label: 'command.rebuildSearchIndex',
    group: 'app',
    scope: 'window',
    keys: [],
  },
  // The Markdown mirror (mirror.ts): choose its folder, or turn it off.
  {
    id: 'mirror.chooseFolder',
    label: 'command.mirrorChooseFolder',
    group: 'app',
    scope: 'window',
    keys: [],
  },
  { id: 'mirror.turnOff', label: 'command.mirrorTurnOff', group: 'app', scope: 'window', keys: [] },
] as const satisfies readonly CommandSpec[]

export type CommandId = (typeof COMMANDS)[number]['id']

/**
 * What the window runs for a command; `label` replaces the registry's for now
 * (Pin or Unpin). `run` may return a promise that settles once it is done.
 */
export interface CommandHandler {
  run: () => void | Promise<unknown>
  label?: MessageKey
}

/** The commands this window can run right now. */
export type CommandHandlers = Partial<Record<CommandId, CommandHandler>>

/**
 * Native menu items (Rust, `src-tauri/src/menu.rs`) that run a command, by
 * menu item ID. Their accelerators must be the command's first key (a test
 * compares them).
 */
export const NATIVE_MENU_COMMANDS: Readonly<Record<string, CommandId>> = {
  'devot.history': 'note.history',
  'devot.palette': 'palette.open',
  'devot.sidebar': 'view.sidebar',
  // A check item; Rust toggles the setting itself, and drops the echo of a
  // key the window ran the command for (see menu.rs).
  'devot.syncScroll': 'view.syncScroll',
  'devot.togglePreview': 'view.togglePreview',
  'devot.split': 'view.split',
  // In the app menu (Devot > Backups...).
  'devot.backups': 'app.backups',
}

/**
 * The accelerators of the native menu items that run a command
 * (`command_menu_set`): each command's first key from `keysOf` (the keys in
 * effect unless given), or null for none.
 */
export function commandMenuKeys(
  keysOf: (id: CommandId) => readonly string[] = commandKeys,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const id of Object.values(NATIVE_MENU_COMMANDS)) {
    const key = keysOf(id)[0]
    out[id] = key === undefined ? null : shortcutAccelerator(key)
  }
  return out
}

/**
 * Keys macOS or the app menu keep for themselves; no command may take them
 * (Quit, Hide, Hide Others, Minimize, Close, Settings, app switching,
 * Spotlight, full screen, the character viewer, Lock Screen, Look Up).
 */
export const RESERVED_KEYS: readonly string[] = [
  'Mod+Q',
  'Mod+H',
  'Mod+Alt+H',
  'Mod+M',
  'Mod+W',
  'Mod+,',
  'Mod+Tab',
  'Mod+Space',
  'Mod+Ctrl+F',
  'Mod+Ctrl+Space',
  'Mod+Ctrl+Q',
  'Mod+Ctrl+D',
]

const BY_ID = new Map<string, CommandSpec>(COMMANDS.map((c) => [c.id, c]))

export function command(id: CommandId): CommandSpec {
  return BY_ID.get(id)!
}

/**
 * The keys in effect for each command: the defaults with the user's changes
 * (see `keymap.ts`), set by the shortcut settings (`shortcutSettings.ts`).
 * Until then every command has its default keys.
 */
let keysInEffect: ReadonlyMap<string, readonly string[]> | undefined

/** Sets the keys in effect; undefined restores the defaults. */
export function setCommandKeys(keys: ReadonlyMap<string, readonly string[]> | undefined): void {
  keysInEffect = keys
}

/** A command's keys in effect; the first is the one shown. */
export function commandKeys(id: CommandId): readonly string[] {
  return keysInEffect?.get(id) ?? command(id).keys
}

/** A command's default keys (the registry's own). */
export function defaultKeys(id: CommandId): readonly string[] {
  return command(id).keys
}

/** Whether a key press is one of this command's keys. */
export function commandMatches(id: CommandId, e: KeyPress): boolean {
  return commandKeys(id).some((key) => keyMatches(key, e))
}

/**
 * Whether a held key (auto-repeat) is a command's key that has Command or
 * Control on it. A command runs once per press, so the key does nothing
 * more; but it must still be stopped, or the held key would repeat into
 * the menu bar (Command+A would select all the text of the window, Command+C
 * would replace what was copied). Keys of the editor are its own.
 */
export function heldCommandKey(e: KeyPress): boolean {
  return (
    e.repeat === true &&
    (e.metaKey || e.ctrlKey) &&
    COMMANDS.some(
      (c) => c.scope !== 'editor' && commandKeys(c.id).some((key) => keyMatches(key, e, true)),
    )
  )
}

/** Whether `outer` is `inner` or one of the scopes it lies within. */
function within(inner: CommandScope, outer: CommandScope): boolean {
  for (let s: CommandScope | null = inner; s !== null; s = SCOPE_PARENT[s]) {
    if (s === outer) return true
  }
  return false
}

/**
 * Whether keys in these two scopes can both be live at once: one lies within
 * the other. Sibling scopes never are (the editor and the rest of the
 * window; the library's list and the Trash's; a notebook row and a tag row).
 */
export function scopesOverlap(a: CommandScope, b: CommandScope): boolean {
  return within(a, b) || within(b, a)
}

/** Keys that two commands take where both apply. */
export function shortcutClashes(
  commands: readonly Pick<CommandSpec, 'id' | 'scope' | 'keys'>[],
): { key: string; ids: [string, string] }[] {
  const out: { key: string; ids: [string, string] }[] = []
  commands.forEach((a, i) => {
    for (const b of commands.slice(i + 1)) {
      if (!scopesOverlap(a.scope, b.scope)) continue
      for (const key of a.keys) if (b.keys.includes(key)) out.push({ key, ids: [a.id, b.id] })
    }
  })
  return out
}

/**
 * The window command a key press asks for: one whose scope is the whole
 * window, or the window outside the editor when the editor does not have
 * the focus.
 */
export function windowCommand(e: KeyPress, where: { inEditor: boolean }): CommandId | undefined {
  return COMMANDS.find(
    (c) =>
      // Widened: no command may be outside the editor only at the moment.
      ((c.scope as CommandScope) === 'window' ||
        ((c.scope as CommandScope) === 'outsideEditor' && !where.inEditor)) &&
      commandKeys(c.id).some((key) => keyMatches(key, e)),
  )?.id
}

/** What follows `prefix` in a command ID (`format.bold` -> `bold`), or undefined. */
function idAfter(prefix: string, id: string): string | undefined {
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined
}

/** The editor keys of the commands whose IDs start with `prefix`, in CodeMirror key notation. */
function editorKeys(prefix: string): { name: string; key: string }[] {
  return COMMANDS.flatMap((c) => {
    const name = c.scope === 'editor' ? idAfter(prefix, c.id) : undefined
    return name === undefined
      ? []
      : commandKeys(c.id).map((key) => ({ name, key: shortcutCodeMirror(key) }))
  })
}

/** A command's editor keys, in CodeMirror key notation. */
export function editorCommandKeys(id: CommandId): string[] {
  return commandKeys(id).map(shortcutCodeMirror)
}

const FORMAT_PREFIX = 'format.'

/** The editor's format commands: their ID, the format each applies and their keys. */
function formatCommands(): {
  id: CommandId
  format: FormatId
  keys: readonly string[]
}[] {
  return COMMANDS.flatMap((c) =>
    c.scope === 'editor' && c.id.startsWith(FORMAT_PREFIX)
      ? [
          {
            id: c.id,
            format: c.id.slice(FORMAT_PREFIX.length) as FormatId,
            keys: commandKeys(c.id),
          },
        ]
      : [],
  )
}

/** The editor's format keymap, in CodeMirror key notation. */
export function editorFormatKeys(): { format: FormatId; key: string }[] {
  return formatCommands().flatMap(({ format, keys }) =>
    keys.map((key) => ({ format, key: shortcutCodeMirror(key) })),
  )
}

/** The format a `format.*` command applies. */
export function formatOf(id: CommandId): FormatId | undefined {
  return idAfter(FORMAT_PREFIX, id) as FormatId | undefined
}

/**
 * The keys of the menu bar's Format menu (src-tauri/src/format_menu.rs):
 * each format command's first key, as a native menu accelerator, less those
 * of the formats in `inert` (they do nothing where the caret is, so their
 * keys stay with the editor's other bindings).
 */
export function formatMenuKeys(inert: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { id, format, keys } of formatCommands()) {
    if (keys[0] !== undefined && !inert.has(format)) out[id] = shortcutAccelerator(keys[0])
  }
  return out
}

/** Whether a Format menu item's payload names a format command. */
export function isFormatMenuCommand(id: unknown): id is CommandId {
  return formatCommands().some((c) => c.id === id)
}

const INSERT_PREFIX = 'insert.'

/** The editor's insertion keymap (none by default), in CodeMirror key notation. */
export function editorInsertKeys(): { insert: InsertId; key: string }[] {
  return editorKeys(INSERT_PREFIX).map(({ name, key }) => ({ insert: name as InsertId, key }))
}

/** The insertion an `insert.*` command makes. */
export function insertOf(id: CommandId): InsertId | undefined {
  return idAfter(INSERT_PREFIX, id) as InsertId | undefined
}

const TABLE_PREFIX = 'table.'

/** The editor's table keymap, in CodeMirror key notation. */
export function editorTableKeys(): { command: TableCommandId; key: string }[] {
  return editorKeys(TABLE_PREFIX).map(({ name, key }) => ({
    command: name as TableCommandId,
    key,
  }))
}

/** The table command a `table.*` command runs. */
export function tableOf(id: CommandId): TableCommandId | undefined {
  return idAfter(TABLE_PREFIX, id) as TableCommandId | undefined
}
