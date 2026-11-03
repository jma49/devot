// Quick tagging's list and its recents. Recents are tag IDs kept on this device only: never synced or logged.
import type { TagRecord } from '../../core/storage'
import { compareNames } from '../../core/sort'
import { trimWhitespace } from '../../core/text'
import { MAX_SUGGESTIONS, tagRows, type TagRow } from './tagRows'

const RECENT_KEY = 'devot.tags.recent'
const MAX_RECENT = 8

interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readRecentTags(storage: KeyValue | undefined): string[] {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT)
      : []
  } catch {
    return []
  }
}

export function rememberTag(storage: KeyValue | undefined, id: string): void {
  const next = [id, ...readRecentTags(storage).filter((each) => each !== id)].slice(0, MAX_RECENT)
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Private browsing or a full store: recents are a convenience.
  }
}

/** With text, what the tag field suggests; empty, the recent tags and then the rest by name. */
export function quickTagRows(
  tags: readonly TagRecord[],
  onNote: readonly string[],
  draft: string,
  recent: readonly string[],
): TagRow[] {
  if (trimWhitespace(draft)) return tagRows(tags, onNote, draft)
  const free = tags.filter((tag) => !onNote.includes(tag.id))
  const first = recent.flatMap((id) => free.filter((tag) => tag.id === id))
  const rest = free
    .filter((tag) => !recent.includes(tag.id))
    .sort((a, b) => compareNames(a.name, b.name, navigator.languages))
  return [...first, ...rest].slice(0, MAX_SUGGESTIONS).map((tag) => ({ kind: 'tag', tag }))
}
