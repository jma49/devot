// The tag context menu: a native menu with the tag actions, shown for a tag
// row in the sidebar. Its actions are registry commands (labels and keys);
// the Colour submenu only picks a colour.
import { TAG_COLORS, type TagColor } from '../../core/storage'
import type { KeyPress } from './commands/keys'
import { commandMatches, type CommandId } from './commands/registry'
import {
  commandEntry,
  type CommandEntryOptions,
  type MenuEntry,
  type MenuGroups,
} from './contextMenu'

/** `color` names the Colour submenu; its items pick `color.none` or `color.<id>`. */
export type TagAction =
  | 'rename'
  | 'settings'
  | 'color'
  | 'color.none'
  | `color.${TagColor}`
  | 'filter'
  | 'copyId'
  | 'delete'

/** What the menu needs to know about the tag that was right-clicked. */
export interface TagMenuTarget {
  id: string
  color: TagColor | null
  /** Whether the list is filtered by this tag now. */
  filtered: boolean
  /** Shown in a workspace's sidebar, which deletes no tag (it is in notes outside it too). */
  inWorkspace?: boolean
}

const COLOR_ITEMS: MenuEntry<TagAction, TagMenuTarget>[] = [
  { action: 'color.none', label: 'tagColor.none', checked: (tag) => tag.color === null },
  ...TAG_COLORS.map((color): MenuEntry<TagAction, TagMenuTarget> => ({
    action: `color.${color}`,
    label: `tagColor.${color}`,
    checked: (tag) => tag.color === color,
  })),
]

type CommandAction = Exclude<TagAction, `color${string}`>

/** The registry command behind each tag action (its label and keys). */
export const TAG_COMMANDS: Readonly<Record<CommandAction, CommandId>> = {
  rename: 'tag.rename',
  settings: 'tag.settings',
  filter: 'tag.filter',
  copyId: 'tag.copyId',
  delete: 'tag.delete',
}

const entry = (
  action: CommandAction,
  more: CommandEntryOptions<TagAction, TagMenuTarget> = {},
): MenuEntry<TagAction, TagMenuTarget> =>
  commandEntry<TagAction, TagMenuTarget>(action, TAG_COMMANDS[action], more)

/** The menu's items, group by group; `tagShortcut` handles the keys shown. */
export const TAG_MENU: MenuGroups<TagAction, TagMenuTarget> = [
  // Rename is F2 only: Tag Settings holds the name.
  [entry('settings'), { action: 'color', label: 'tagMenu.color', submenu: COLOR_ITEMS }],
  [entry('filter', { checked: (tag) => tag.filtered })],
  [entry('copyId')],
  [entry('delete', { shown: (tag) => !tag.inWorkspace })],
]

/** The colour a Colour item picks (null: none), or undefined for other actions. */
export function colorOfAction(action: TagAction): TagColor | null | undefined {
  if (action === 'color.none') return null
  const id = action.startsWith('color.') ? action.slice('color.'.length) : undefined
  return TAG_COLORS.find((color) => color === id)
}

/** The tag action a key press on a tag row asks for, if any. */
export function tagShortcut(e: KeyPress): CommandAction | undefined {
  return (Object.keys(TAG_COMMANDS) as CommandAction[]).find((action) =>
    commandMatches(TAG_COMMANDS[action], e),
  )
}
