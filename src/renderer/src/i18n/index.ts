// UI strings by key. English ships today; adding a locale means adding a
// catalog to `catalogs` and nothing else changes in UI code.
import { fillPlaceholders } from '../../../core/text'
import { en, type MessageKey, type Messages } from './en'

export type { MessageKey } from './en'

const catalogs: Record<string, Partial<Messages>> = { en }

export const SOURCE_LOCALE = 'en'

export function resolveLocale(preferred: readonly string[]): string {
  for (const tag of preferred) {
    const lower = tag.toLowerCase()
    if (catalogs[lower]) return lower
    const base = lower.split('-')[0] ?? ''
    if (catalogs[base]) return base
  }
  return SOURCE_LOCALE
}

let active: Partial<Messages> = en
let activeLocale = SOURCE_LOCALE

export function setLocale(locale: string): void {
  active = catalogs[locale] ?? en
  activeLocale = catalogs[locale] ? locale : SOURCE_LOCALE
}

export function currentLocale(): string {
  return activeLocale
}

export function t(key: MessageKey): string {
  return active[key] ?? en[key]
}

/**
 * `template` with each `{name}` replaced by `values[name]`, in one pass: a
 * value is inserted as plain text and never read again, so a name with `$`
 * or braces in it shows as typed. Placeholders without a value stay. Never
 * fill a placeholder with `String.replace` (tests/policy/placeholders.test.ts).
 */
export const format = fillPlaceholders
