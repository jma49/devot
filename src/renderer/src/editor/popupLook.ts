// How a completion popup shows its rows: which list an option belongs to
// (each list has its own row style) and what it shows before its label (an
// icon, an alert's coloured icon, a glyph such as an emoji, or a small ring).
// The sources record it here; editor/completions.ts draws it.
import type { Completion } from '@codemirror/autocomplete'
import type { IconName } from '../icons/symbols'
import type { AlertKind } from './blocks'

export type PopupList = 'slash' | 'language' | 'emoji' | 'alert' | 'paste'

export interface OptionLook {
  list: PopupList
  icon?: IconName
  tone?: AlertKind
  glyph?: string
}

const looks = new WeakMap<Completion, OptionLook>()

export function withLook<T extends Completion>(option: T, look: OptionLook): T {
  looks.set(option, look)
  return option
}

export function lookOf(option: Completion): OptionLook | undefined {
  return looks.get(option)
}

export const ALERT_ICONS: Record<AlertKind, IconName> = {
  note: 'alert.note',
  tip: 'alert.tip',
  important: 'alert.important',
  warning: 'alert.warning',
  caution: 'alert.caution',
}
