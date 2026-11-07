// A note's front matter as rows of properties: the preview's properties block and the Note Info
// card both draw from it.
import { parse, stringify } from 'yaml'
import { noteTitle, readFrontMatterYaml, type FrontMatterMeta } from '../import'
import type { TagColorValue } from '../storage'
import { sameName } from '../tags'
import { fillPlaceholders } from '../text'
import type { PreviewNote } from './registry'

export type NoteField = 'title' | 'status' | 'tags'

export interface PropertyChip {
  name: string
  color?: TagColorValue
}

/** The note's own value of a field the front matter names otherwise, and the value Apply sets. */
export interface PropertyDifference {
  field: NoteField
  badge: string
  /** Null when the front matter's text names nothing the note can take (a status that does not exist). */
  value: string | null
}

export interface PropertyRow {
  key: string
  value: { kind: 'text'; text: string } | { kind: 'chips'; chips: PropertyChip[] }
  difference?: PropertyDifference
}

/** YAML that is not a map of keys stays as written. */
export type FrontMatterView =
  | { kind: 'properties'; rows: PropertyRow[] }
  | { kind: 'yaml'; yaml: string }

function valueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && !(value instanceof Date)) return stringify(value).trimEnd()
  return value instanceof Date ? value.toISOString() : String(value)
}

const tagChip = (name: string, note: PreviewNote): PropertyChip => {
  const color = note.tagColors.find((tag) => sameName(tag.name, name))?.color
  return color ? { name, color } : { name }
}

function difference(
  field: NoteField,
  shown: string,
  value: string | null,
  note: PreviewNote,
): PropertyDifference {
  return { field, badge: fillPlaceholders(note.labels.noteValue, { value: shown }), value }
}

/** Null when the front matter says what the note does. */
function fieldDifference(
  field: NoteField,
  meta: FrontMatterMeta,
  written: string,
  note: PreviewNote,
  untitled: string,
): PropertyDifference | null {
  if (field === 'title') {
    if (meta.title === null || meta.title.trim() === '') return null
    const title = noteTitle(meta.title)
    if (title === note.title) return null
    return difference(field, note.title || untitled, title, note)
  }
  if (field === 'status') {
    if (meta.status === note.status) return null
    // Text that names no status cannot be applied, but it still is not the note's status.
    if (meta.status === null && written.trim() === '') return null
    return difference(field, note.labels.statuses[note.status], meta.status, note)
  }
  const same =
    meta.tags.length === note.tags.length &&
    meta.tags.every((name) => note.tags.some((own) => sameName(own, name)))
  if (same) return null
  const shown = note.tags.length > 0 ? note.tags.join(', ') : note.labels.noTags
  return difference(field, shown, JSON.stringify(meta.tags), note)
}

const isNoteField = (key: string): key is NoteField =>
  key === 'title' || key === 'status' || key === 'tags'

function propertyRows(
  yaml: string,
  note: PreviewNote | undefined,
  untitled: string,
): PropertyRow[] | null {
  let data: unknown
  try {
    data = parse(yaml, { maxAliasCount: 16 })
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const entries = Object.entries(data as Record<string, unknown>)
  const meta = note ? readFrontMatterYaml(yaml) : null
  // As import reads them: keys match in any case and the last of a repeated one counts.
  const fieldRows = new Map<NoteField, number>()
  entries.forEach(([key], i) => {
    const field = key.toLowerCase()
    if (isNoteField(field)) fieldRows.set(field, i)
  })
  const fieldAt = new Map([...fieldRows].map(([field, i]) => [i, field]))
  const rows = entries.map(([key, value], i): PropertyRow => {
    const field = note && meta ? fieldAt.get(i) : undefined
    const list = Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')
    const shown: PropertyRow['value'] =
      field === 'tags' && meta && note
        ? { kind: 'chips', chips: meta.tags.map((name) => tagChip(name, note)) }
        : list
          ? { kind: 'chips', chips: (value as unknown[]).map((v) => ({ name: valueText(v) })) }
          : { kind: 'text', text: valueText(value) }
    const added =
      field && meta && note ? fieldDifference(field, meta, valueText(value), note, untitled) : null
    return added ? { key, value: shown, difference: added } : { key, value: shown }
  })
  return rows.length > 0 ? rows : null
}

/**
 * The rows of front matter `yaml`. With `note` (the open note's own fields), a title, status or tags
 * that differ from the note's carry the note's value and what Apply would set.
 */
export function frontMatterView(
  yaml: string,
  note: PreviewNote | undefined,
  untitled: string,
): FrontMatterView {
  const rows = propertyRows(yaml, note, untitled)
  return rows ? { kind: 'properties', rows } : { kind: 'yaml', yaml }
}

/** How many properties the summary counts: a block that is not a map of keys counts as one. */
export const propertyCount = (view: FrontMatterView | null): number =>
  view === null ? 0 : view.kind === 'properties' ? view.rows.length : 1
