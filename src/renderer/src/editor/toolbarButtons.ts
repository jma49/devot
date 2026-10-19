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

export const TOOLBAR_GROUPS: readonly (readonly ToolbarButton[])[] = [
  (['heading', 'bold', 'italic', 'strikethrough', 'highlight', 'link'] as const).map(button),
  (['code', 'codeBlock'] as const).map(button),
  (['bulletList', 'numberedList', 'taskList', 'quote', 'alert'] as const).map(button),
]

const NO_KEY: ReadonlySet<ToolbarFormat> = new Set(['heading', 'highlight', 'alert'])

export interface Tip {
  title: string
  key?: string
}

export function commandTip(id: CommandId, title: string): Tip {
  const key = commandKeys(id)[0]
  return key === undefined ? { title } : { title, key: shortcutLabel(key) }
}

export function toolbarTip(b: ToolbarButton): Tip {
  const title = t(b.title)
  return NO_KEY.has(b.id) ? { title } : commandTip(`format.${b.id}` as CommandId, title)
}
