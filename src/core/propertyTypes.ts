// Typed note properties: the front matter keys other than the ones Devot keeps as note fields. Apart
// from properties.ts, which reads YAML, so the window types and checks them without the parser.
import { charCount } from './text'

export type PropertyValue = string | number | boolean | readonly string[] | null

export type PropertyType = 'text' | 'number' | 'checkbox' | 'date' | 'list'

export type Properties = Readonly<Record<string, PropertyValue>>

/** Front matter keys a note keeps as its own fields (title, tags, status) or that templates read (notebook): never table columns. */
const FIELD_KEYS = new Set(['title', 'tags', 'status', 'notebook'])

export const MAX_PROPERTY_KEY_CHARS = 64
export const MAX_PROPERTY_TEXT_CHARS = 2_000
export const MAX_PROPERTY_ITEMS = 100

const DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/

export const isFieldKey = (key: string) => FIELD_KEYS.has(key.toLowerCase())

export function validPropertyKey(key: string): boolean {
  return (
    key.trim() === key &&
    key !== '' &&
    charCount(key) <= MAX_PROPERTY_KEY_CHARS &&
    !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(key) &&
    !isFieldKey(key)
  )
}

/** The type a column of values reads as: checkboxes, numbers or dates when every value given is one, a list when any is, text otherwise. */
export function propertyType(values: Iterable<PropertyValue>): PropertyType {
  let type: PropertyType | undefined
  for (const value of values) {
    if (value === null) continue
    const own: PropertyType = Array.isArray(value)
      ? 'list'
      : typeof value === 'boolean'
        ? 'checkbox'
        : typeof value === 'number'
          ? 'number'
          : DATE.test(value as string)
            ? 'date'
            : 'text'
    if (own === 'list') return 'list'
    if (type === undefined) type = own
    else if (type !== own) type = 'text'
  }
  return type ?? 'text'
}
