// The selection toolbar's buttons, in their groups, and what each one's
// tooltip says: its name and the key in effect from the command registry
// (so a rebound key shows), none for Heading, Highlight and Alert.
import { t, type MessageKey } from '../i18n'
import type { IconName } from '../icons/symbols'
import { shortcutLabel } from '../commands/keys'
import { commandKeys, type CommandId } from '../commands/registry'
import type { ToolbarFormat } from './formats'

export interface ToolbarButton {
  id: ToolbarFormat
  label: MessageKey
  title: MessageKey
  icon: IconName
}

const button = (id: ToolbarFormat): ToolbarButton => ({
  id,
  label: `format.${id}` as MessageKey,
  title: `format.${id}Title` as MessageKey,
  icon: `format.${id}` as IconName,
})

/** The groups, left to right, with a divider between each. */
export const TOOLBAR_GROUPS: readonly (readonly ToolbarButton[])[] = [
  (['heading', 'bold', 'italic', 'strikethrough', 'highlight', 'link'] as const).map(button),
  (['code', 'codeBlock'] as const).map(button),
  (['bulletList', 'numberedList', 'taskList', 'quote', 'alert'] as const).map(button),
]

/** Buttons whose tooltip shows no key. */
const NO_KEY: ReadonlySet<ToolbarFormat> = new Set(['heading', 'highlight', 'alert'])

/** A floating button's tooltip: a name, and a key when it has one. */
export interface Tip {
  title: string
  key?: string
}

/** The tooltip of a toolbar button, with the format command's first key in effect. */
export function toolbarTip(b: ToolbarButton): Tip {
  const title = t(b.title)
  if (NO_KEY.has(b.id)) return { title }
  const key = commandKeys(`format.${b.id}` as CommandId)[0]
  return key === undefined ? { title } : { title, key: shortcutLabel(key) }
}
