// Settings > Keyboard's search field: which commands the typed words leave in
// the table. Every word must be found in the command's name, its group's
// name or one of its keys in effect, as shown (`⌘K`) or as written (`Mod+K`),
// whatever the case.
import { shortcutLabel } from '../commands/keys'
import type { CommandGroup, CommandSpec } from '../commands/registry'
import { t, type MessageKey } from '../i18n'

export const GROUP_LABELS: Readonly<Record<CommandGroup, MessageKey>> = {
  note: 'shortcuts.group.note',
  notebook: 'shortcuts.group.notebook',
  tag: 'shortcuts.group.tag',
  view: 'shortcuts.group.view',
  search: 'shortcuts.group.search',
  find: 'shortcuts.group.find',
  edit: 'shortcuts.group.edit',
  format: 'shortcuts.group.format',
  table: 'shortcuts.group.table',
  image: 'shortcuts.group.image',
  app: 'shortcuts.group.app',
}

export function matchesQuery(
  c: Pick<CommandSpec, 'label' | 'group'>,
  keys: readonly string[],
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = [t(c.label), t(GROUP_LABELS[c.group]), ...keys, ...keys.map(shortcutLabel)]
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}
