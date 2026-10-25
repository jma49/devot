// The note header's context menus: one for a tag chip and one for the
// notebook label. Their items are registry commands (labels and keys) of the
// sidebar's tag and notebook menus, run on the open note's tag or notebook.
import { commandEntry, type MenuGroups } from './contextMenu'

export type ChipAction = 'settings' | 'remove' | 'filter' | 'copyId'

export interface ChipMenuTarget {
  tagId: string
  filtered: boolean
}

export const CHIP_MENU: MenuGroups<ChipAction, ChipMenuTarget> = [
  [
    commandEntry('settings', 'tag.settings'),
    { action: 'remove', label: 'note.removeTag', edits: true },
  ],
  [commandEntry('filter', 'tag.filter', { checked: (chip) => chip.filtered })],
  [commandEntry('copyId', 'tag.copyId')],
]

export type NotebookAction = 'open' | 'copyId'

export interface NotebookMenuTarget {
  bookId: string
}

export const NOTEBOOK_MENU: MenuGroups<NotebookAction, NotebookMenuTarget> = [
  [commandEntry('open', 'note.showNotebook', { label: 'noteHeader.openNotebook' })],
  [commandEntry('copyId', 'notebook.copyId')],
]
