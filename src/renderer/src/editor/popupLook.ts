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
  /** An icon in the text colour, or the alert colour of `tone`. */
  icon?: IconName
  tone?: AlertKind
  /** Text shown in the icon's place (an emoji). */
  glyph?: string
}

const looks = new WeakMap<Completion, OptionLook>()

/** Records how an option shows; returns the option. */
export function withLook<T extends Completion>(option: T, look: OptionLook): T {
  looks.set(option, look)
  return option
}

/** How an option shows, if a source of these recorded it. */
export function lookOf(option: Completion): OptionLook | undefined {
  return looks.get(option)
}

/** The icon of each alert kind. */
export const ALERT_ICONS: Record<AlertKind, IconName> = {
  note: 'alert.note',
  tip: 'alert.tip',
  important: 'alert.important',
  warning: 'alert.warning',
  caution: 'alert.caution',
}
