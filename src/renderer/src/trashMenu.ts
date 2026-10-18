// The menu of a row in the Trash's list: Restore and Delete Permanently. On a
// row that is part of a multiple selection both act on every selected note,
// and their labels say so. The actions are the Trash's own (`TrashAction`).
import { commandEntry, useContextMenu, type MenuGroups } from './contextMenu'
import { TRASH_COMMANDS, type TrashAction } from './noteMenu'

/** The trashed note that was right-clicked, and how many notes the menu acts on. */
export interface TrashMenuTarget {
  id: string
  /** The selection's size when the row is selected with others, else 1. */
  count: number
}

const many = (target: TrashMenuTarget) => target.count > 1

export const TRASH_NOTE_MENU: MenuGroups<TrashAction, TrashMenuTarget> = [
  [
    commandEntry<TrashAction, TrashMenuTarget>('restore', TRASH_COMMANDS.restore, {
      label: (n) => (many(n) ? 'batch.restore' : 'command.restoreFromTrash'),
    }),
  ],
  [
    commandEntry<TrashAction, TrashMenuTarget>('deleteForever', TRASH_COMMANDS.deleteForever, {
      label: (n) => (many(n) ? 'batch.deleteForever' : 'trash.deleteForever'),
    }),
  ],
]

/** The Trash list's menu for this window; a picked item calls `onPick` with its target. */
export function useTrashMenu(onPick: (action: TrashAction, target: TrashMenuTarget) => void) {
  return useContextMenu('trash', TRASH_NOTE_MENU, onPick)
}
