// The saved search row's menu and the search field's: their items are registry commands (labels
// and keys), shown as native menus.
import type { KeyPress } from './commands/keys'
import { commandMatches, type CommandId } from './commands/registry'
import { commandEntry, type MenuEntry, type MenuGroups } from './contextMenu'

export type SavedSearchAction = 'rename' | 'edit' | 'delete'

export interface SavedSearchMenuTarget {
  id: string
}

export const SAVED_SEARCH_COMMANDS: Readonly<Record<SavedSearchAction, CommandId>> = {
  rename: 'savedSearch.rename',
  edit: 'savedSearch.edit',
  delete: 'savedSearch.delete',
}

const entry = (action: SavedSearchAction): MenuEntry<SavedSearchAction, SavedSearchMenuTarget> =>
  commandEntry<SavedSearchAction, SavedSearchMenuTarget>(action, SAVED_SEARCH_COMMANDS[action])

export const SAVED_SEARCH_MENU: MenuGroups<SavedSearchAction, SavedSearchMenuTarget> = [
  [entry('rename'), entry('edit')],
  [entry('delete')],
]

export function savedSearchShortcut(e: KeyPress): SavedSearchAction | undefined {
  return (Object.keys(SAVED_SEARCH_COMMANDS) as SavedSearchAction[]).find((action) =>
    commandMatches(SAVED_SEARCH_COMMANDS[action], e),
  )
}

export type SearchFieldAction = 'save'

/** The search field's options: Save Search keeps the query typed under a name. */
export const SEARCH_FIELD_MENU: MenuGroups<SearchFieldAction, { query: string }> = [
  [commandEntry<SearchFieldAction, { query: string }>('save', 'search.save')],
]
