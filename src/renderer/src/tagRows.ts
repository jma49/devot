import type { TagRecord } from '../../core/storage'
import { sameName } from '../../core/tags'
import { compareNames } from '../../core/sort'
import { trimWhitespace } from '../../core/text'

export type TagRow = { kind: 'tag'; tag: TagRecord } | { kind: 'create'; name: string }

export const MAX_SUGGESTIONS = 8

/**
 * What the tag field suggests for `draft`: the tags not in `exclude` whose
 * names hold it (those that start with it first), then a last row that
 * makes a tag of the text, unless a tag of that name exists. Nothing while
 * the field is empty.
 */
export function tagRows(
  tags: readonly TagRecord[],
  exclude: readonly string[],
  draft: string,
): TagRow[] {
  const text = trimWhitespace(draft)
  if (!text) return []
  const want = text.toLocaleLowerCase()
  const found = tags
    .filter((tag) => !exclude.includes(tag.id) && tag.name.toLocaleLowerCase().includes(want))
    .sort(
      (a, b) =>
        Number(!a.name.toLocaleLowerCase().startsWith(want)) -
          Number(!b.name.toLocaleLowerCase().startsWith(want)) ||
        compareNames(a.name, b.name, navigator.languages),
    )
    .slice(0, MAX_SUGGESTIONS)
  const rows: TagRow[] = found.map((tag) => ({ kind: 'tag', tag }))
  const exists = tags.some((tag) => sameName(tag.name, text))
  if (!exists) rows.push({ kind: 'create', name: text })
  return rows
}
