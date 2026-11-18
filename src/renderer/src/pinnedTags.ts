import type { TagRecord } from '../../core/storage'
import { localStore } from './localStore'

export const PINNED_TAGS_KEY = 'devot.pinnedTags'

export type PinnedTagStore = Pick<Storage, 'getItem' | 'setItem'>

function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && !seen.has(item)) {
      seen.add(item)
      out.push(item)
    }
  }
  return out
}

export function readPinnedTags(storage: PinnedTagStore | undefined = localStore()): string[] {
  try {
    return normalize(JSON.parse(storage?.getItem(PINNED_TAGS_KEY) ?? '[]'))
  } catch {
    return []
  }
}

export function togglePinnedTag(
  id: string,
  storage: PinnedTagStore | undefined = localStore(),
): string[] {
  const current = readPinnedTags(storage)
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
  try {
    storage?.setItem(PINNED_TAGS_KEY, JSON.stringify(next))
  } catch {
    console.warn('W_PINNED_TAGS_SAVE_FAILED')
  }
  return next
}

/** Keeps pinned tags ahead of unpinned tags while preserving each group's relative order. */
export function orderTagsWithPinned(
  tags: readonly TagRecord[],
  pinned: ReadonlySet<string>,
): TagRecord[] {
  if (pinned.size === 0) return [...tags]
  const top: TagRecord[] = []
  const rest: TagRecord[] = []
  for (const tag of tags) {
    if (pinned.has(tag.id)) top.push(tag)
    else rest.push(tag)
  }
  return [...top, ...rest]
}
