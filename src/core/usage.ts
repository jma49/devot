// Usage events: how Devot is used, recorded on this device only. Every event is declared in USAGE_EVENTS, and its properties can only be enums of fixed tokens,
// counts and durations, so no event can carry note content, titles, names or IDs. The types reject anything else at compile time and `checkUsageEvent` rejects it
// again at run time (a policy test scans the catalog). Nothing is sent anywhere: see UsageTransport.

export type UsageProperty =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'count' }
  | { readonly kind: 'duration' }

const oneOf = <const V extends readonly string[]>(...values: V) =>
  ({ kind: 'enum', values }) as const
const count = { kind: 'count' } as const
const duration = { kind: 'duration' } as const

export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21-100', '101+'] as const
export type CountBucket = (typeof COUNT_BUCKETS)[number]

/** Adding an event: name it `area.past_tense`, declare its properties here (all are required), give it a label in the i18n catalog (`usage.event.<name>`) and call `track`. */
export const USAGE_EVENTS = {
  'note.created': { from: oneOf('new_note', 'link', 'duplicate', 'selection', 'template') },
  'search.run': { scope: oneOf('all', 'view'), clauses: count, results: oneOf(...COUNT_BUCKETS) },
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

export type UsageProperties<N extends UsageEventName> = {
  readonly [K in keyof (typeof USAGE_EVENTS)[N]]: ValueOf<(typeof USAGE_EVENTS)[N][K]>
}

export interface UsageEvent {
  name: UsageEventName
  properties: Record<string, string | number>
}

export interface StoredUsageEvent {
  id: number
  at: number
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

export function countBucket(n: number): CountBucket {
  if (n <= 0) return '0'
  if (n === 1) return '1'
  if (n <= 5) return '2-5'
  if (n <= 20) return '6-20'
  if (n <= 100) return '21-100'
  return '101+'
}

export type Track = <N extends UsageEventName>(name: N, properties: UsageProperties<N>) => void

/** An invalid event or a failed store is reported to `onError` by code and dropped, so usage data can never break what the user was doing. */
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

export function usageCounts(
  events: readonly StoredUsageEvent[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
  return [...counts]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Nothing implements it, and no code path sends events anywhere. An upload ships with accounts and only as an opt-in. */
export interface UsageTransport {
  /** Oldest first; rejects with a code when it cannot deliver. */
  send(events: readonly StoredUsageEvent[]): Promise<void>
}
