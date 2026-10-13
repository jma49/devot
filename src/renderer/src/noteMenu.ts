// The note context menu: a native menu (Tauri menu API) with the note
// actions, and the same actions as shortcuts while the note list has focus;
// also the keys of the Trash's list. On a row that is part of a multiple
// selection the menu acts on every selected note: its labels say so, and the
// items for one note only (Revision History, Duplicate, Copy Note URI and
// ID, and the export and print items) are hidden, while the status and tag
// items show.
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
import { t } from './i18n'
import { invoke } from './ipc'
import { STATUS_COMMANDS } from './statusKeys'

export type NoteAction =
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

/** The note's export and print actions (see exporter.ts). */
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

/** The registry command behind each note action (its label and keys). */
export const NOTE_COMMANDS: Readonly<Record<NoteAction, CommandId>> = {
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

/** Note actions for several selected notes only (see `NOTE_MENU`). */
export const SELECTION_ONLY: ReadonlySet<NoteAction> = new Set(['addTag', 'removeTag'])

/**
 * Everything the menu can do: the note actions, and for several notes their
 * status (`status:<status>`) and tags.
 */
export type NoteMenuAction = NoteAction | 'status' | `status:${NoteStatus}`

/** The menu's items, group by group; `noteShortcut` handles the keys shown. */
const entry = (
  action: NoteAction,
  more: CommandEntryOptions<NoteMenuAction, NoteMenuTarget> = {},
) => commandEntry<NoteMenuAction, NoteMenuTarget>(action, NOTE_COMMANDS[action], more)

const one = (target: NoteMenuTarget) => target.ids.length <= 1
/** Several notes (not templates, whose status and tags are not used). */
const severalNotes = (target: NoteMenuTarget) => !one(target) && !target.templates
/** Several notes, some with a tag to take off. */
const severalTagged = (target: NoteMenuTarget) => severalNotes(target) && target.tagged

export const NOTE_MENU: MenuGroups<NoteMenuAction, NoteMenuTarget> = [
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
  EXPORT_ACTIONS.map((action) => entry(action, { shown: one })),
  [entry('trash', { label: (n) => (one(n) ? 'note.moveToTrash' : 'batch.trash') })],
]

/**
 * The note action a key press on a note list row asks for, if any: the keys
 * of the note commands in the registry (Revision History's works window-wide
 * too). The tag actions act only on several notes (`SELECTION_ONLY`).
 */
export function noteShortcut(e: KeyPress): NoteAction | undefined {
  return (Object.keys(NOTE_COMMANDS) as NoteAction[]).find((action) =>
    commandMatches(NOTE_COMMANDS[action], e),
  )
}

/** What the keys of the Trash's list do to the open (trashed) note. */
export type TrashAction = 'restore' | 'deleteForever'

/** The registry command behind each Trash action. */
export const TRASH_COMMANDS: Readonly<Record<TrashAction, CommandId>> = {
  restore: 'trash.restore',
  deleteForever: 'trash.deleteForever',
}

/** The Trash action a key press on a row of the Trash's list asks for, if any. */
export function trashShortcut(e: KeyPress): TrashAction | undefined {
  return (Object.keys(TRASH_COMMANDS) as TrashAction[]).find((action) =>
    commandMatches(TRASH_COMMANDS[action], e),
  )
}

/** What the copy actions put on the clipboard. */
export function noteClipboardText(
  action: 'copyLink' | 'copyUri' | 'copyId',
  note: { id: string; title: string },
): string {
  if (action === 'copyUri') return noteUri(note.id)
  if (action === 'copyId') return note.id
  return noteLink(note.title || t('note.untitled'), note.id)
}

/** Puts plain text on the system clipboard (through Rust: see `clipboard_write_text`). */
export async function copyText(text: string): Promise<void> {
  await invoke('clipboard_write_text', { text })
}

/** The links Copy Note Links puts on the clipboard: one per line. */
export function noteLinks(notes: readonly { id: string; title: string }[]): string {
  return notes.map((note) => noteClipboardText('copyLink', note)).join('\n')
}

/**
 * What the menu needs to know about the notes it acts on: the right-clicked
 * one, or every selected note when that one is selected with others.
 */
export interface NoteMenuTarget {
  /** The notes, the right-clicked one alone or the selection. */
  ids: readonly string[]
  /** Whether every one of them is pinned. */
  pinned: boolean
  /** The status they all have; null when they differ. */
  status: NoteStatus | null
  /** Whether they are templates. */
  templates: boolean
  /** Whether any of them has a tag. */
  tagged: boolean
}

/**
 * The note context menu for this window. Returns `show(target)`, which pops
 * the menu up at the pointer; a picked item calls `onPick` with that target.
 */
export function useNoteMenu(onPick: (action: NoteMenuAction, target: NoteMenuTarget) => void) {
  const pick = useCallback(
    (action: NoteMenuAction, target: NoteMenuTarget) => onPick(action, target),
    [onPick],
  )
  return useContextMenu('note', NOTE_MENU, pick)
}
