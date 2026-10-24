// The note context menu: a native menu (Tauri menu API) with the note
// actions, and the same actions as shortcuts while the note list has focus;
// also the keys of the Trash's list. On a row that is part of a multiple
// selection the menu acts on every selected note: its labels say so, and the
// items for one note only (Revision History, Duplicate, Copy Note URI and
// ID, PDF, print and copy as HTML) are hidden, while the status and tag
// items show, and Export as Markdown and HTML export the selected notes.
import { useCallback } from 'react'
import { noteLink, noteUri } from '../../core/links'
import { NOTE_STATUSES, type NoteStatus } from '../../core/storage'
import type { KeyPress } from './commands/keys'
import { commandMatches, type CommandId } from './commands/registry'
import {
  commandEntry,
  useContextMenu,
  type CommandEntryOptions,
  type MenuGroups,
} from './contextMenu'
import { displayTitle } from './headlines'
import type { MessageKey } from './i18n'
import { invoke } from './ipc'
import { STATUS_COMMANDS } from './statusKeys'

export type NoteAction =
  | 'openWindow'
  | 'move'
  | 'history'
  | 'duplicate'
  | 'pin'
  | 'copyLink'
  | 'copyUri'
  | 'copyId'
  | ExportAction
  | 'trash'
  | 'addTag'
  | 'removeTag'

export type ExportAction =
  | 'exportHtml'
  | 'copyHtml'
  | 'copySimpleHtml'
  | 'exportMarkdown'
  | 'exportPdf'
  | 'print'

export const EXPORT_ACTIONS: readonly ExportAction[] = [
  'exportHtml',
  'copyHtml',
  'copySimpleHtml',
  'exportMarkdown',
  'exportPdf',
  'print',
]

export const NOTE_COMMANDS: Readonly<Record<NoteAction, CommandId>> = {
  openWindow: 'note.openInWindow',
  move: 'note.move',
  history: 'note.history',
  duplicate: 'note.duplicate',
  pin: 'note.pin',
  copyLink: 'note.copyLink',
  copyUri: 'note.copyUri',
  copyId: 'note.copyId',
  exportHtml: 'note.exportHtml',
  copyHtml: 'note.copyHtml',
  copySimpleHtml: 'note.copySimpleHtml',
  exportMarkdown: 'note.exportMarkdown',
  exportPdf: 'note.exportPdf',
  print: 'note.print',
  trash: 'note.trash',
  addTag: 'note.addTag',
  removeTag: 'note.removeTag',
}

/** Export actions that also act on several notes (side by side), with labels for one note and for several. */
const SELECTION_EXPORT_LABELS: Partial<Record<ExportAction, readonly [MessageKey, MessageKey]>> = {
  exportMarkdown: ['noteMenu.exportMarkdown', 'noteMenu.exportSelectionMarkdown'],
  exportHtml: ['noteMenu.exportHtml', 'noteMenu.exportSelectionHtml'],
}

export const SELECTION_EXPORTS: ReadonlySet<ExportAction> = new Set(
  Object.keys(SELECTION_EXPORT_LABELS) as ExportAction[],
)

export const SELECTION_ONLY: ReadonlySet<NoteAction> = new Set(['addTag', 'removeTag'])

export type NoteMenuAction = NoteAction | 'status' | `status:${NoteStatus}`

const entry = (
  action: NoteAction,
  more: CommandEntryOptions<NoteMenuAction, NoteMenuTarget> = {},
) => commandEntry<NoteMenuAction, NoteMenuTarget>(action, NOTE_COMMANDS[action], more)

const one = (target: NoteMenuTarget) => target.ids.length <= 1
const severalNotes = (target: NoteMenuTarget) => !one(target) && !target.templates
const severalTagged = (target: NoteMenuTarget) => severalNotes(target) && target.tagged

export const NOTE_MENU: MenuGroups<NoteMenuAction, NoteMenuTarget> = [
  [entry('openWindow', { shown: (n) => one(n) && !n.templates })],
  [
    entry('move', { label: (n) => (one(n) ? 'noteMenu.move' : 'batch.move') }),
    entry('history', { shown: one }),
  ],
  [
    entry('duplicate', { shown: one }),
    entry('pin', {
      label: (n) =>
        one(n) ? (n.pinned ? 'note.unpin' : 'note.pin') : n.pinned ? 'batch.unpin' : 'batch.pin',
    }),
  ],
  [
    {
      action: 'status',
      label: 'note.statusLabel',
      shown: severalNotes,
      submenu: NOTE_STATUSES.map((status) =>
        commandEntry<NoteMenuAction, NoteMenuTarget>(`status:${status}`, STATUS_COMMANDS[status], {
          label: `status.${status}`,
          checked: (n) => n.status === status,
        }),
      ),
    },
    entry('addTag', { shown: severalNotes }),
    entry('removeTag', { shown: severalTagged }),
  ],
  [
    entry('copyLink', { label: (n) => (one(n) ? 'noteMenu.copyLink' : 'batch.copyLinks') }),
    entry('copyUri', { shown: one }),
    entry('copyId', { shown: one }),
  ],
  EXPORT_ACTIONS.map((action) => {
    const labels = SELECTION_EXPORT_LABELS[action]
    return labels
      ? entry(action, { label: (n) => (one(n) ? labels[0] : labels[1]) })
      : entry(action, { shown: one })
  }),
  [entry('trash', { label: (n) => (one(n) ? 'note.moveToTrash' : 'batch.trash') })],
]

/** The note action a key press on a list row asks for: the note commands' keys in the registry (Revision History's works window-wide too). Tag actions act only on several notes (`SELECTION_ONLY`). */
export function noteShortcut(e: KeyPress): NoteAction | undefined {
  return (Object.keys(NOTE_COMMANDS) as NoteAction[]).find((action) =>
    commandMatches(NOTE_COMMANDS[action], e),
  )
}

export type TrashAction = 'restore' | 'deleteForever'

export const TRASH_COMMANDS: Readonly<Record<TrashAction, CommandId>> = {
  restore: 'trash.restore',
  deleteForever: 'trash.deleteForever',
}

export function trashShortcut(e: KeyPress): TrashAction | undefined {
  return (Object.keys(TRASH_COMMANDS) as TrashAction[]).find((action) =>
    commandMatches(TRASH_COMMANDS[action], e),
  )
}

/** What the copy actions put on the clipboard; a note's `title` is its display title (`displayTitles`), and without one a link is named "Untitled". */
export function noteClipboardText(
  action: 'copyLink' | 'copyUri' | 'copyId',
  note: { id: string; title: string },
): string {
  if (action === 'copyUri') return noteUri(note.id)
  if (action === 'copyId') return note.id
  return noteLink(displayTitle(note.title, undefined), note.id)
}

export async function copyText(text: string): Promise<void> {
  await invoke('clipboard_write_text', { text })
}

export function noteLinks(notes: readonly { id: string; title: string }[]): string {
  return notes.map((note) => noteClipboardText('copyLink', note)).join('\n')
}

/** The right-clicked note, or every selected note when it is selected with others. */
export interface NoteMenuTarget {
  ids: readonly string[]
  pinned: boolean
  status: NoteStatus | null
  templates: boolean
  tagged: boolean
}

/** Returns `show(target)`, which pops the menu up at the pointer; a picked item calls `onPick` with that target. */
export function useNoteMenu(onPick: (action: NoteMenuAction, target: NoteMenuTarget) => void) {
  const pick = useCallback(
    (action: NoteMenuAction, target: NoteMenuTarget) => onPick(action, target),
    [onPick],
  )
  return useContextMenu('note', NOTE_MENU, pick)
}
