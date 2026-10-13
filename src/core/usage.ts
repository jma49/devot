// Usage events: how Devot is used, recorded on this device only. Every event
// is declared in USAGE_EVENTS, and its properties can only be enums of fixed
// tokens, counts and durations, so no event can carry note content, titles,
// names or IDs. The types reject anything else at compile time and
// `checkUsageEvent` rejects it again at run time (a policy test scans the
// catalog). The app stores events in a bounded local store (Rust,
// `src-tauri/src/usage.rs`); Settings shows and clears them. Nothing is sent
// anywhere: see UsageTransport.

/** A property's declared shape. */
export type UsageProperty =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  /** A whole number of things, 0 or more. */
  | { readonly kind: 'count' }
  /** Whole milliseconds, 0 or more. */
  | { readonly kind: 'duration' }

const oneOf = <const V extends readonly string[]>(...values: V) =>
  ({ kind: 'enum', values }) as const
const count = { kind: 'count' } as const
const duration = { kind: 'duration' } as const

/** How many results a search found, as a bucket rather than a number. */
export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21-100', '101+'] as const
export type CountBucket = (typeof COUNT_BUCKETS)[number]

/**
 * Every event the app records, with its properties. Adding an event: name it
 * `area.past_tense`, declare its properties here (all are required), give it
 * a label in the i18n catalog (`usage.event.<name>`) and call `track`.
 */
export const USAGE_EVENTS = {
  /** A note was made: with New Note, from the `[[` popup, as a copy, from selected text or from a template. */
  'note.created': { from: oneOf('new_note', 'link', 'duplicate', 'selection', 'template') },
  /** A search ran after typing paused: where, how many clauses, how many results. */
  'search.run': { scope: oneOf('all', 'view'), clauses: count, results: oneOf(...COUNT_BUCKETS) },
  /** A Markdown folder import finished. */
  'import.finished': {
    notes: count,
    notebooks: count,
    images: count,
    problems: count,
    durationMs: duration,
  },
} as const satisfies Record<string, Record<string, UsageProperty>>

export type UsageEventName = keyof typeof USAGE_EVENTS

type ValueOf<P> = P extends { kind: 'enum'; values: readonly (infer V)[] } ? V : number

/** The properties `track` takes for an event: exactly the declared ones. */
export type UsageProperties<N extends UsageEventName> = {
  readonly [K in keyof (typeof USAGE_EVENTS)[N]]: ValueOf<(typeof USAGE_EVENTS)[N][K]>
}

/** A checked event, ready to store. */
export interface UsageEvent {
  name: UsageEventName
  properties: Record<string, string | number>
}

/** An event as the local store returns it (`at`: milliseconds since the epoch). */
export interface StoredUsageEvent {
  id: number
  at: number
  /** Usually a catalog name; events from another Devot version may differ. */
  name: string
  properties: Record<string, string | number>
}

export type UsageCheck =
  | { ok: true; event: UsageEvent }
  | {
      ok: false
      code:
        | 'E_USAGE_UNKNOWN_EVENT'
        | 'E_USAGE_BAD_PROPERTIES'
        | 'E_USAGE_UNKNOWN_PROPERTY'
        | 'E_USAGE_MISSING_PROPERTY'
        | 'E_USAGE_BAD_VALUE'
    }

const isName = (name: string): name is UsageEventName => Object.hasOwn(USAGE_EVENTS, name)

function validValue(property: UsageProperty, value: unknown): value is string | number {
  if (property.kind === 'enum') return typeof value === 'string' && property.values.includes(value)
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Checks an event against the catalog. The properties come back as a new
 * plain object holding only the declared keys.
 */
export function checkUsageEvent(name: string, properties: unknown): UsageCheck {
  if (!isName(name)) return { ok: false, code: 'E_USAGE_UNKNOWN_EVENT' }
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties))
    return { ok: false, code: 'E_USAGE_BAD_PROPERTIES' }
  const declared: Record<string, UsageProperty> = USAGE_EVENTS[name]
  for (const key of Object.keys(properties)) {
    if (!Object.hasOwn(declared, key)) return { ok: false, code: 'E_USAGE_UNKNOWN_PROPERTY' }
  }
  const given = properties as Record<string, unknown>
  const checked: Record<string, string | number> = {}
  for (const [key, property] of Object.entries(declared)) {
    if (!Object.hasOwn(given, key)) return { ok: false, code: 'E_USAGE_MISSING_PROPERTY' }
    const value = given[key]
    if (!validValue(property, value)) return { ok: false, code: 'E_USAGE_BAD_VALUE' }
    checked[key] = value
  }
  return { ok: true, event: { name, properties: checked } }
}

/** The bucket a count falls in. */
export function countBucket(n: number): CountBucket {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n <= 5) return '2-5'
  if (n <= 20) return '6-20'
  if (n <= 100) return '21-100'
  return '101+'
}

/** Records one event; never throws and never waits. */
export type Track = <N extends UsageEventName>(name: N, properties: UsageProperties<N>) => void

/**
 * The tracker the app calls. `record` stores a checked event; an invalid
 * event or a failed store is reported to `onError` by code and dropped, so
 * usage data can never break what the user was doing.
 */
export function createUsageTracker(options: {
  record: (event: UsageEvent) => Promise<void>
  onError: (code: string) => void
}): Track {
  return (name, properties) => {
    const result = checkUsageEvent(name, properties)
    if (!result.ok) return options.onError(result.code)
    try {
      options.record(result.event).catch(() => options.onError('W_USAGE_RECORD_FAILED'))
    } catch {
      options.onError('W_USAGE_RECORD_FAILED')
    }
  }
}

/** Stored events counted by name, most frequent first (then by name). */
export function usageCounts(
  events: readonly StoredUsageEvent[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  return [...counts]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Where usage events would go when they leave the device. Nothing
 * implements it, and no code path sends events anywhere. An upload ships
 * with accounts and only as an opt-in: an uploader then reads stored events
 * and hands them to a transport only while the user has opted in, and
 * clearing the local events in Settings stays possible.
 */
export interface UsageTransport {
  /** Delivers a batch, oldest first; rejects with a code when it cannot. */
  send(events: readonly StoredUsageEvent[]): Promise<void>
}
