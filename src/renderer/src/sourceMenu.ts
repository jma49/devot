// The context menus of the fixed sidebar rows: Trash, All Notes, and the
// Status and Pinned filter rows. Their actions are registry commands (labels
// and keys), except the filter item, which sets the row's filter.
import type { NoteFilter } from '../../core/tags'
import { commandEntry, type MenuGroups } from './contextMenu'

export type TrashRowAction = 'emptyTrash'

export interface TrashRowTarget {
  notes: number
}

/** Empty Trash shows only while the Trash has notes; the app asks to confirm. */
export const TRASH_ROW_MENU: MenuGroups<TrashRowAction, TrashRowTarget> = [
  [
    commandEntry<TrashRowAction, TrashRowTarget>('emptyTrash', 'trash.empty', {
      label: 'sourceMenu.emptyTrash',
      shown: (trash) => trash.notes > 0,
    }),
  ],
]

export type AllNotesAction = 'showNotes' | 'newNote'

export interface AllNotesTarget {
  canCreate: boolean
}

export const ALL_NOTES_MENU: MenuGroups<AllNotesAction, AllNotesTarget> = [
  [
    commandEntry<AllNotesAction, AllNotesTarget>('showNotes', 'view.allNotes', {
      label: 'sourceMenu.showNotes',
    }),
  ],
  [
    commandEntry<AllNotesAction, AllNotesTarget>('newNote', 'note.new', {
      shown: (row) => row.canCreate,
    }),
  ],
]

export type FilterRowAction = 'filter'

export interface FilterRowTarget {
  filter: Extract<NoteFilter, { kind: 'status' | 'pinned' }>
  filtered: boolean
}

/** A checked item, like the tag menu's: it sets the row's filter, and again clears it. */
export const FILTER_ROW_MENU: MenuGroups<FilterRowAction, FilterRowTarget> = [
  [
    {
      action: 'filter',
      label: (row) =>
        row.filter.kind === 'pinned' ? 'sourceMenu.filterPinned' : 'sourceMenu.filterStatus',
      checked: (row) => row.filtered,
    },
  ],
]
