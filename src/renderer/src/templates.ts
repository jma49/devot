// The template picker's lists. The templates used last are a convenience
// for this device, so they live in the webview's local storage, never in
// the note database, and never sync.

type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const RECENT_KEY = 'devot.templates.recent'
/** How many recently used templates the picker remembers. */
export const MAX_RECENT_TEMPLATES = 5

/** The templates used last on this device, newest first; storage failures read as none. */
export function recentTemplates(storage: KeyValue | undefined) {
  const load = (): string[] => {
    try {
      const value: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? '[]')
      return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENT_TEMPLATES)
        : []
    } catch {
      return []
    }
  }
  return {
    load,
    /** Puts a template first. */
    use(id: string) {
      const next = [id, ...load().filter((other) => other !== id)].slice(0, MAX_RECENT_TEMPLATES)
      try {
        storage?.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        console.warn('W_TEMPLATES_RECENT_SAVE_FAILED')
      }
    },
  }
}

/** This window's store (none where local storage is unavailable). */
export function currentRecentTemplates() {
  let storage: KeyValue | undefined
  try {
    storage = localStorage
  } catch {
    storage = undefined
  }
  return recentTemplates(storage)
}

/**
 * The picker's two groups: the recently used templates that still exist,
 * in the order used, then every other one by title (untitled last), each
 * narrowed to titles containing `query` in any case.
 */
export function templateGroups<T extends { id: string; title: string }>(
  templates: readonly T[],
  recent: readonly string[],
  query: string,
  locales: readonly string[],
): { recent: T[]; others: T[] } {
  const needle = query.trim().toLocaleLowerCase()
  const shown = needle
    ? templates.filter((t) => t.title.toLocaleLowerCase().includes(needle))
    : [...templates]
  const byId = new Map(shown.map((t) => [t.id, t]))
  const first = recent.flatMap((id) => {
    const template = byId.get(id)
    return template ? [template] : []
  })
  const collator = new Intl.Collator([...locales], { numeric: true, sensitivity: 'base' })
  const others = shown
    .filter((t) => !first.includes(t))
    .sort(
      (a, b) =>
        Number(a.title === '') - Number(b.title === '') ||
        collator.compare(a.title, b.title) ||
        (a.id < b.id ? -1 : 1),
    )
  return { recent: first, others }
}
