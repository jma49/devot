// The tag menu's table: its actions are registry commands (labels and keys). `TagMenuPanel.tsx` draws
// it with the colour swatches, which a native menu cannot show.
import type { TagColorValue } from '../../core/storage'
import type { KeyPress } from './commands/keys'
import { commandMatches, type CommandId } from './commands/registry'
import {
  commandEntry,
  type CommandEntryOptions,
  type MenuEntry,
  type MenuGroups,
} from './contextMenu'

export type TagAction = 'rename' | 'settings' | 'filter' | 'copyId' | 'delete'

export interface TagMenuTarget {
  id: string
  color: TagColorValue | null
  filtered: boolean
  /** Shown in a workspace's sidebar, which deletes no tag (it is in notes outside it too). */
  inWorkspace?: boolean
}

export const TAG_COMMANDS: Readonly<Record<TagAction, CommandId>> = {
  rename: 'tag.rename',
  settings: 'tag.settings',
  filter: 'tag.filter',
  copyId: 'tag.copyId',
  delete: 'tag.delete',
}

const entry = (
  action: TagAction,
  more: CommandEntryOptions<TagAction, TagMenuTarget> = {},
): MenuEntry<TagAction, TagMenuTarget> =>
  commandEntry<TagAction, TagMenuTarget>(action, TAG_COMMANDS[action], more)

/** The swatch row follows the first group. Rename is F2 only: Tag Settings holds the name. */
export const TAG_MENU: MenuGroups<TagAction, TagMenuTarget> = [
  [entry('settings')],
  [entry('filter', { checked: (tag) => tag.filtered })],
  [entry('copyId')],
  [entry('delete', { shown: (tag) => !tag.inWorkspace })],
]

export function tagShortcut(e: KeyPress): TagAction | undefined {
  return (Object.keys(TAG_COMMANDS) as TagAction[]).find((action) =>
    commandMatches(TAG_COMMANDS[action], e),
  )
}
