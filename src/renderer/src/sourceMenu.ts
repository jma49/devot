// The context menus of the fixed sidebar rows: Trash, All Notes, and the
// Status and Pinned filter rows. Their actions are registry commands (labels
// and keys), except the filter item, which sets the row's filter.
import type { NoteFilter } from '../../core/tags'
import { commandEntry, type MenuGroups } from './contextMenu'

/** What the Trash row's menu can do. */
export type TrashRowAction = 'emptyTrash'

/** What the Trash row's menu needs to know. */
export interface TrashRowTarget {
  /** How many notes the Trash holds. */
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

/** What the All Notes row's menu can do. */
export type AllNotesAction = 'showNotes' | 'newNote'

/** What the All Notes row's menu needs to know. */
export interface AllNotesTarget {
  /** Whether a note can be made (the library is open). */
  canCreate: boolean
}

// Groups can be added here later (an Export All item is planned).
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

/** What a Status or Pinned row's menu can do. */
export type FilterRowAction = 'filter'

/** What the menu needs to know about the row that was right-clicked. */
export interface FilterRowTarget {
  /** The filter the row sets: pinned notes or one status. */
  filter: Extract<NoteFilter, { kind: 'status' | 'pinned' }>
  /** Whether the list is filtered by this row now. */
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
