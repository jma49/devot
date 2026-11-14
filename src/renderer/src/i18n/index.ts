import { fillPlaceholders } from '../../../core/text'
import { en, type MessageKey, type Messages } from './en'
import { enPhone } from './phone'

export type { MessageKey } from './en'

interface Translation {
  messages: Partial<Messages>
  phone: Partial<Messages>
}

// A translation loads only for a reader who wants it, so no window parses one it never shows.
const translations: Record<string, () => Promise<Translation>> = {
  'zh-hans': () => import('./zh-Hans').then((m) => ({ messages: m.zhHans, phone: m.zhHansPhone })),
}
const catalogs: Record<string, Partial<Messages>> = { en }
const phoneWordings: Record<string, Partial<Messages>> = { en: enPhone }
const known = (locale: string) => locale === 'en' || locale in translations

const SOURCE_LOCALE = 'en'
const TRADITIONAL_CHINESE = /^zh-(?:.*-)?(?:hant|tw|hk|mo)(?:-|$)/

function catalogFor(tag: string): string | undefined {
  const lower = tag.toLowerCase()
  if (known(lower)) return lower
  const base = lower.split('-')[0] ?? ''
  // Traditional Chinese readers get the next language they prefer, not Simplified.
  if (base === 'zh') return TRADITIONAL_CHINESE.test(lower) ? undefined : 'zh-hans'
  return known(base) ? base : undefined
}

export function resolveLocale(preferred: readonly string[]): string {
  for (const tag of preferred) {
    const locale = catalogFor(tag)
    if (locale) return locale
  }
  return SOURCE_LOCALE
}

let active: Partial<Messages> = en
let activeLocale = SOURCE_LOCALE

/** Loads `locale`'s catalog the first time, then makes it the active one. */
export async function setLocale(locale: string): Promise<void> {
  const load = translations[locale]
  if (load && !catalogs[locale]) {
    const { messages, phone } = await load()
    catalogs[locale] = messages
    phoneWordings[locale] = phone
  }
  active = catalogs[locale] ?? en
  activeLocale = catalogs[locale] ? locale : SOURCE_LOCALE
}

export function currentLocale(): string {
  return activeLocale
}

let phoneWording = false

/** Words messages that name the Mac for the iPhone layout. */
export function setIPhoneWording(on: boolean): void {
  phoneWording = on
}

export function t(key: MessageKey): string {
  return (phoneWording ? phoneWordings[activeLocale]?.[key] : undefined) ?? active[key] ?? en[key]
}

/**
 * `template` with each `{name}` replaced by `values[name]`, in one pass: a
 * value is inserted as plain text and never read again, so a name with `$`
 * or braces in it shows as typed. Placeholders without a value stay. Never
 * fill a placeholder with `String.replace` (tests/policy/placeholders.test.ts).
 */
export const format = fillPlaceholders
