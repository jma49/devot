import { fillPlaceholders } from '../../../core/text'
import { startup, type MessageKey, type Messages } from './en'
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
const english: Partial<Messages> = startup
const catalogs: Record<string, Partial<Messages>> = { en: english }
const phoneWordings: Record<string, Partial<Messages>> = { en: enPhone }
const known = (locale: string) => locale === 'en' || locale in translations

const SOURCE_LOCALE = 'en'
/** Each catalog's language as the page declares it (`<html lang>`). */
const SENTENCE_GAPS: Record<string, string> = { 'zh-hans': '' }
const LANGUAGE_TAGS: Record<string, string> = { en: 'en', 'zh-hans': 'zh-Hans' }
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

/**
 * The languages this window shows, most preferred first: the one the Mac app shows now, which it
 * sets before the page loads (`app_language.rs`), else the web view's own.
 */
export function shownLanguages(): readonly string[] {
  const shown = (globalThis as { devotLanguage?: unknown }).devotLanguage
  if (typeof shown === 'string') return [shown]
  return (
    (globalThis as { navigator?: { languages?: readonly string[] } }).navigator?.languages ?? []
  )
}

let active: Partial<Messages> = english
let activeLocale = SOURCE_LOCALE
let requested = 0
const listeners = new Set<() => void>()

/** Loads `locale`'s catalog the first time, then makes it the active one; a later call wins. */
export async function setLocale(locale: string): Promise<void> {
  const request = ++requested
  const load = translations[locale]
  if (load && !catalogs[locale]) {
    const { messages, phone } = await load()
    catalogs[locale] = messages
    phoneWordings[locale] = phone
  }
  if (request !== requested) return
  const before = activeLocale
  active = catalogs[locale] ?? english
  activeLocale = catalogs[locale] ? locale : SOURCE_LOCALE
  // WebKit picks Han glyphs, line breaks and VoiceOver's voice by the page's language.
  const page = (globalThis as { document?: { documentElement: { lang: string } } }).document
  if (page) page.documentElement.lang = LANGUAGE_TAGS[activeLocale] ?? SOURCE_LOCALE
  if (activeLocale !== before) for (const listener of [...listeners]) listener()
}

/** Calls `listener` after each change of the active locale; returns what stops it. */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Sentences shown one after another: a space apart, but none after Chinese full-width punctuation. */
export function sentences(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join(SENTENCE_GAPS[activeLocale] ?? ' ')
}

export function currentLocale(): string {
  return activeLocale
}

let phoneWording = false
let onIPad = false

/** Words messages that name the Mac for the iPhone layout. */
export function setIPhoneWording(on: boolean): void {
  phoneWording = on
}

/** The phone layout's messages name the iPhone; on an iPad they name the iPad, in every language. */
export function setPhoneDevice(device: 'iPhone' | 'iPad'): void {
  onIPad = device === 'iPad'
}

/** An area's English fallback loads only in the windows that show it. */
export function registerMessages(messages: Partial<Messages>): void {
  Object.assign(english, messages)
}

export function englishText(key: MessageKey): string {
  const text = english[key]
  if (text === undefined) throw new Error('E_I18N_MESSAGE_UNLOADED')
  return text
}

export function t(key: MessageKey): string {
  const text =
    (phoneWording ? phoneWordings[activeLocale]?.[key] : undefined) ??
    active[key] ??
    englishText(key)
  return phoneWording && onIPad ? text.replaceAll('iPhone', 'iPad') : text
}

/**
 * `template` with each `{name}` replaced by `values[name]`, in one pass: a
 * value is inserted as plain text and never read again, so a name with `$`
 * or braces in it shows as typed. Placeholders without a value stay. Never
 * fill a placeholder with `String.replace` (tests/policy/placeholders.test.ts).
 */
export const format = fillPlaceholders
