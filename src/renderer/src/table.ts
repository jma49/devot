// The table layout's columns, order, filters and cells: the note fields, then each front matter
// property the view's notes hold, typed by their values (core/propertyTypes.ts).
import { isRecord } from '../../core/isRecord'
import { NOTE_STATUSES } from '../../core/storage'
import type { NoteSummary } from '../../core'
import {
  propertyType,
  type Properties,
  type PropertyType,
  type PropertyValue,
} from '../../core/propertyTypes'

export type FieldColumn = 'title' | 'status' | 'tags' | 'updated'

export type TableColumn =
  | { id: `field:${FieldColumn}`; field: FieldColumn }
  | { id: `property:${string}`; key: string; type: PropertyType }

export type TableFilter = 'filled' | 'empty' | 'checked' | 'unchecked'

export interface TableSettings {
  sort?: { column: string; descending: boolean } | undefined
  filters: Readonly<Record<string, TableFilter>>
  hidden: readonly string[]
  /** Properties added from the table that no note holds yet. */
  added: readonly string[]
}

export const NO_SETTINGS: TableSettings = { filters: {}, hidden: [], added: [] }

const FIELDS: readonly FieldColumn[] = ['title', 'status', 'tags', 'updated']

export const propertyColumnId = (key: string): `property:${string}` => `property:${key}`

/** The fields, then the properties the most notes hold first (ties by name), then those added from the table; hidden ones left out. */
export function tableColumns(
  notes: readonly NoteSummary[],
  properties: ReadonlyMap<string, Properties>,
  settings: TableSettings,
  collator: Pick<Intl.Collator, 'compare'>,
): TableColumn[] {
  const counts = new Map<string, number>()
  const values = new Map<string, PropertyValue[]>()
  for (const note of notes) {
    const own = properties.get(note.id)
    if (!own) continue
    for (const key in own) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      const list = values.get(key)
      if (list) list.push(own[key]!)
      else values.set(key, [own[key]!])
    }
  }
  for (const key of settings.added) if (!counts.has(key)) counts.set(key, 0)
  const keys = [...counts.keys()].sort(
    (a, b) => counts.get(b)! - counts.get(a)! || collator.compare(a, b),
  )
  const hidden = new Set(settings.hidden)
  const columns: TableColumn[] = FIELDS.map((field) => ({ id: `field:${field}`, field }))
  for (const key of keys) {
    columns.push({ id: propertyColumnId(key), key, type: propertyType(values.get(key) ?? []) })
  }
  return columns.filter((c) => c.id === 'field:title' || !hidden.has(c.id))
}

type Sortable = string | number | boolean | null

function cellOf(
  note: NoteSummary,
  column: TableColumn,
  properties: ReadonlyMap<string, Properties>,
  tagNames: (note: NoteSummary) => readonly string[],
): Sortable {
  if ('field' in column) {
    if (column.field === 'title') return note.title === '' ? null : note.title
    if (column.field === 'status')
      return note.status === 'none' ? null : NOTE_STATUSES.indexOf(note.status)
    if (column.field === 'updated') return note.updatedAt
    const tags = tagNames(note)
    return tags.length === 0 ? null : tags.join(', ')
  }
  const value = properties.get(note.id)?.[column.key]
  if (value === undefined || value === null) return null
  if (Array.isArray(value)) return value.length === 0 ? null : value.join(', ')
  return value as Sortable
}

const isFilled = (value: Sortable) => value !== null && value !== ''

function passes(value: Sortable, filter: TableFilter): boolean {
  if (filter === 'filled') return isFilled(value)
  if (filter === 'empty') return !isFilled(value)
  return filter === 'checked' ? value === true : value !== true
}

function compare(a: Sortable, b: Sortable, collator: Pick<Intl.Collator, 'compare'>): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return collator.compare(String(a), String(b))
}

/**
 * The rows the table shows: the view's notes through the filters, in the sorted column's order (empty
 * cells last either way, then the view's order), else the view's.
 */
export function tableRows(
  notes: readonly NoteSummary[],
  columns: readonly TableColumn[],
  properties: ReadonlyMap<string, Properties>,
  settings: TableSettings,
  tagNames: (note: NoteSummary) => readonly string[],
  collator: Pick<Intl.Collator, 'compare'>,
): readonly NoteSummary[] {
  const byId = new Map<string, TableColumn>(columns.map((c) => [c.id, c]))
  const filters = Object.entries(settings.filters).flatMap(([id, filter]) => {
    const column = byId.get(id)
    return column ? [{ column, filter }] : []
  })
  const kept =
    filters.length === 0
      ? notes
      : notes.filter((note) =>
          filters.every(({ column, filter }) =>
            passes(cellOf(note, column, properties, tagNames), filter),
          ),
        )
  const sorted = settings.sort && byId.get(settings.sort.column)
  if (!sorted) return kept
  const sign = settings.sort!.descending ? -1 : 1
  const keyed = kept.map((note, index) => ({
    note,
    index,
    value: cellOf(note, sorted, properties, tagNames),
  }))
  keyed.sort((a, b) => {
    const aEmpty = !isFilled(a.value)
    const bEmpty = !isFilled(b.value)
    if (aEmpty || bEmpty) return aEmpty === bEmpty ? a.index - b.index : aEmpty ? 1 : -1
    return sign * compare(a.value, b.value, collator) || a.index - b.index
  })
  return keyed.map((k) => k.note)
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** What a cell edited as `text` writes: null when cleared; a number column keeps numbers as numbers, a list splits at commas. */
export function parseCell(type: PropertyType, text: string): PropertyValue {
  const trimmed = text.trim()
  if (type === 'list') {
    return trimmed === ''
      ? null
      : trimmed
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
  }
  if (trimmed === '') return null
  if (type === 'number' && NUMBER.test(trimmed)) return Number(trimmed)
  return type === 'text' ? text.replace(/[\r\n\u2028\u2029]+/g, ' ') : trimmed
}

/** A cell's value as its editor starts with it. */
export function editText(value: PropertyValue | undefined): string {
  if (value === undefined || value === null) return ''
  return Array.isArray(value) ? value.join(', ') : String(value)
}

export function withFilter(
  settings: TableSettings,
  column: string,
  filter: TableFilter | undefined,
): TableSettings {
  const { [column]: _, ...others } = settings.filters
  return { ...settings, filters: filter ? { ...others, [column]: filter } : others }
}

const FILTERS: readonly string[] = [
  'filled',
  'empty',
  'checked',
  'unchecked',
] satisfies TableFilter[]
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 200) : []

export function readTableSettings(value: unknown): TableSettings {
  if (!isRecord(value)) return NO_SETTINGS
  const sort =
    isRecord(value['sort']) && typeof value['sort']['column'] === 'string'
      ? { column: value['sort']['column'], descending: value['sort']['descending'] === true }
      : undefined
  const filters: Record<string, TableFilter> = {}
  if (isRecord(value['filters'])) {
    for (const [column, filter] of Object.entries(value['filters'])) {
      if (typeof filter === 'string' && FILTERS.includes(filter))
        filters[column] = filter as TableFilter
    }
  }
  return { sort, filters, hidden: strings(value['hidden']), added: strings(value['added']) }
}

/** Views whose table settings are kept, the one changed last at the end. */
const VIEWS_KEPT = 100
const STORE_KEY = 'devot.tables'

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

/** Each view's table settings, kept for the install; storage failures mean none. */
export function tableSettingsStore(storage: KeyValue | undefined) {
  const all = (): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(storage?.getItem(STORE_KEY) ?? '{}')
      return isRecord(value) ? value : {}
    } catch {
      return {}
    }
  }
  return {
    load: (view: string): TableSettings => readTableSettings(all()[view]),
    save(view: string, settings: TableSettings) {
      const { [view]: _, ...others } = all()
      const kept = Object.entries(others).slice(-(VIEWS_KEPT - 1))
      try {
        storage?.setItem(STORE_KEY, JSON.stringify(Object.fromEntries([...kept, [view, settings]])))
      } catch {
        console.warn('W_TABLE_SETTINGS_SAVE_FAILED')
      }
    },
  }
}
