export const RECENT_SEARCHES_KEY = 'devot.phone.recentSearches'
export const MAX_RECENT_SEARCHES = 6

type KeyValue = Pick<Storage, 'getItem' | 'setItem'>

/** This device's own: search terms are note content in spirit, so they are neither synced nor logged. */
export function readRecentSearches(storage: KeyValue | undefined): string[] {
  try {
    const stored: unknown = JSON.parse(storage?.getItem(RECENT_SEARCHES_KEY) ?? '[]')
    return Array.isArray(stored)
      ? stored
          .filter((q): q is string => typeof q === 'string' && q !== '')
          .slice(0, MAX_RECENT_SEARCHES)
      : []
  } catch {
    return []
  }
}

export function rememberSearch(storage: KeyValue | undefined, query: string): string[] {
  const clean = query.trim()
  const before = readRecentSearches(storage)
  if (clean === '') return before
  const next = [clean, ...before.filter((q) => q !== clean)].slice(0, MAX_RECENT_SEARCHES)
  try {
    storage?.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
  } catch {
    // Private browsing or a full store: recent searches are a convenience.
  }
  return next
}

// A row's one line holds about 45 characters, and the core's excerpt can put the match 40 in.
const SHOWN_BEFORE_MATCH = 12

export function excerptNearMatch(excerpt: string, pattern: RegExp | null): string {
  if (!pattern) return excerpt
  const first = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(excerpt)
  const lead = excerpt.startsWith('…') ? 1 : 0
  if (!first || first.index - lead <= SHOWN_BEFORE_MATCH) return excerpt
  const before = excerpt.slice(lead, first.index)
  const wordBreak = before.indexOf(' ', before.length - SHOWN_BEFORE_MATCH)
  let from = wordBreak >= 0 ? wordBreak + 1 : before.length - SHOWN_BEFORE_MATCH
  const unit = before.charCodeAt(from)
  if (unit >= 0xdc00 && unit <= 0xdfff) from += 1
  return `…${excerpt.slice(lead + from)}`
}
