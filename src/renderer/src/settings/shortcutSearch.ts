// Settings > Keyboard's filter field and groups. Every typed word must be found in the command's
// name, its group's name or one of its keys in effect, as shown (`⌘K`) or as written (`Mod+K`),
// whatever the case; a typed key may name its modifiers as people say them (`cmd+k`,
// `shift+opt+cmd+d`), and then finds that key alone.
import { normalizeShortcut, shortcutLabel } from '../commands/keys'
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

export const GROUP_ORDER: readonly CommandGroup[] = [
  'app',
  'note',
  'notebook',
  'tag',
  'view',
  'search',
  'find',
  'edit',
  'format',
  'table',
  'image',
]

const MODIFIER_WORDS: Readonly<Record<string, string>> = {
  mod: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  '\u2318': 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  '\u2303': 'Ctrl',
  alt: 'Alt',
  opt: 'Alt',
  option: 'Alt',
  '\u2325': 'Alt',
  shift: 'Shift',
  '\u21e7': 'Shift',
}

/** A typed `cmd+shift+k` as the written key (`mod+shift+k`), or undefined when it names none. */
function typedKey(word: string): string | undefined {
  const parts = word.split('+')
  const key = parts.pop()
  if (parts.length === 0 || !key) return undefined
  const modifiers = parts.map((part) => MODIFIER_WORDS[part])
  if (modifiers.some((m) => m === undefined)) return undefined
  try {
    return normalizeShortcut([...modifiers, key].join('+')).toLowerCase()
  } catch {
    return undefined
  }
}

export function matchesQuery(
  c: Pick<CommandSpec, 'label' | 'group'>,
  keys: readonly string[],
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const written = keys.map((key) => key.toLowerCase())
  const text = [t(c.label), t(GROUP_LABELS[c.group]), ...keys, ...keys.map(shortcutLabel)]
    .join(' ')
    .toLowerCase()
  return words.every((word) => {
    const key = typedKey(word)
    if (key !== undefined) return written.includes(key)
    const modifier = MODIFIER_WORDS[word]
    return text.includes(word) || (modifier !== undefined && text.includes(modifier.toLowerCase()))
  })
}

export interface ShortcutGroup<C> {
  group: CommandGroup
  commands: C[]
}

/** The commands the query leaves, by group in `GROUP_ORDER`, each in the registry's order; empty groups left out. */
export function groupedShortcuts<C extends Pick<CommandSpec, 'id' | 'label' | 'group'>>(
  commands: readonly C[],
  keymap: ReadonlyMap<string, readonly string[]>,
  query: string,
): ShortcutGroup<C>[] {
  const shown = commands.filter((c) => matchesQuery(c, keymap.get(c.id) ?? [], query))
  return GROUP_ORDER.map((group) => ({
    group,
    commands: shown.filter((c) => c.group === group),
  })).filter((g) => g.commands.length > 0)
}
