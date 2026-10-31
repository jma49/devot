// What an Apply button in the preview's front matter asks for (see the
// `devot.frontmatter` renderer): the note field to set and its new value.
import type { NoteStatus, TagRecord } from '../../../core'
import { NOTE_STATUSES } from '../../../core/storage'
import { sameName } from '../../../core/tags'

export type FrontMatterChange =
  | { field: 'title'; value: string }
  | { field: 'status'; value: NoteStatus }
  | { field: 'tags'; value: string[] }

/** The button's `data-frontmatter-apply` and `data-frontmatter-value`; null for anything the renderer would not have written. */
export function frontMatterChange(
  field: string | null,
  value: string | null,
): FrontMatterChange | null {
  if (value === null) return null
  if (field === 'title') return { field, value }
  if (field === 'status') {
    return (NOTE_STATUSES as readonly string[]).includes(value)
      ? { field, value: value as NoteStatus }
      : null
  }
  if (field !== 'tags') return null
  let names: unknown
  try {
    names = JSON.parse(value)
  } catch {
    return null
  }
  return Array.isArray(names) && names.every((name) => typeof name === 'string')
    ? { field, value: names }
    : null
}

/** The tags to add (by name, made when missing) and to take off (by ID) so the note has just `names`. */
export function tagChanges(
  own: readonly Pick<TagRecord, 'id' | 'name'>[],
  names: readonly string[],
): { add: string[]; remove: string[] } {
  return {
    add: names.filter((name) => !own.some((tag) => sameName(tag.name, name))),
    remove: own.filter((tag) => !names.some((name) => sameName(tag.name, name))).map((t) => t.id),
  }
}
