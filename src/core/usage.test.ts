import { describe, expect, it } from 'vitest'
import {
  COUNT_BUCKETS,
  USAGE_EVENTS,
  checkUsageEvent,
  countBucket,
  createUsageTracker,
  usageCounts,
  type StoredUsageEvent,
  type UsageEvent,
} from './usage'

const valid = {
  'note.created': { from: 'new_note' },
  'search.run': { scope: 'all', clauses: 2, results: '2-5' },
  'import.finished': { notes: 3, notebooks: 2, images: 1, problems: 0, durationMs: 1250 },
} as const

describe('the usage event catalog', () => {
  it('has an example for every event, and each example is valid', () => {
    expect(Object.keys(valid).sort()).toEqual(Object.keys(USAGE_EVENTS).sort())
    for (const [name, properties] of Object.entries(valid)) {
      expect(checkUsageEvent(name, properties)).toEqual({ ok: true, event: { name, properties } })
    }
  })

  it('declares properties only as enums, counts and durations', () => {
    for (const properties of Object.values(USAGE_EVENTS)) {
      for (const property of Object.values(properties)) {
        expect(['enum', 'count', 'duration']).toContain(property.kind)
      }
    }
  })
})

describe('checkUsageEvent', () => {
  const fails = (name: string, properties: unknown) => {
    const result = checkUsageEvent(name, properties)
    return result.ok ? 'ok' : result.code
  }

  it('rejects events that are not in the catalog', () => {
    expect(fails('note.deleted', {})).toBe('E_USAGE_UNKNOWN_EVENT')
    expect(fails('toString', {})).toBe('E_USAGE_UNKNOWN_EVENT')
    expect(fails('__proto__', {})).toBe('E_USAGE_UNKNOWN_EVENT')
  })

  it('rejects strings that are not declared enum values', () => {
    // A note title, a name or an ID can never pass as an enum value.
    expect(fails('note.created', { from: 'Meeting notes' })).toBe('E_USAGE_BAD_VALUE')
    expect(fails('note.created', { from: '01920000-0000-7000-8000-000000000001' })).toBe(
      'E_USAGE_BAD_VALUE',
    )
    expect(fails('note.created', { from: 'NEW_NOTE' })).toBe('E_USAGE_BAD_VALUE')
    expect(fails('search.run', { ...valid['search.run'], results: '7' })).toBe('E_USAGE_BAD_VALUE')
    // Strings never stand in for counts or durations.
    expect(fails('search.run', { ...valid['search.run'], clauses: '2' })).toBe('E_USAGE_BAD_VALUE')
  })

  it('accepts only whole, non-negative, safe numbers for counts and durations', () => {
    const run = (clauses: unknown) => fails('search.run', { ...valid['search.run'], clauses })
    expect(run(0)).toBe('ok')
    for (const bad of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, null, true, [], {}]) {
      expect(run(bad)).toBe('E_USAGE_BAD_VALUE')
    }
    const imported = (durationMs: unknown) =>
      fails('import.finished', { ...valid['import.finished'], durationMs })
    expect(imported(0)).toBe('ok')
    expect(imported(-5)).toBe('E_USAGE_BAD_VALUE')
    expect(imported(0.5)).toBe('E_USAGE_BAD_VALUE')
  })

  it('rejects undeclared and missing properties', () => {
    expect(fails('note.created', { from: 'link', title: 'Plan' })).toBe('E_USAGE_UNKNOWN_PROPERTY')
    expect(fails('note.created', { from: 'link', noteId: 7 })).toBe('E_USAGE_UNKNOWN_PROPERTY')
    expect(fails('note.created', {})).toBe('E_USAGE_MISSING_PROPERTY')
    expect(fails('note.created', null)).toBe('E_USAGE_BAD_PROPERTIES')
    expect(fails('note.created', 'new_note')).toBe('E_USAGE_BAD_PROPERTIES')
    expect(fails('note.created', ['new_note'])).toBe('E_USAGE_BAD_PROPERTIES')
  })

  it('reads own properties only, into a fresh plain object', () => {
    const inherited = Object.create({ from: 'link' }) as object
    expect(fails('note.created', inherited)).toBe('E_USAGE_MISSING_PROPERTY')
    const result = checkUsageEvent('note.created', { from: 'link' })
    expect(result.ok && Object.getPrototypeOf(result.event.properties)).toBe(Object.prototype)
  })
})

describe('countBucket', () => {
  it('puts every count in a declared bucket', () => {
    const cases: [number, string][] = [
      [0, '0'],
      [1, '1'],
      [2, '2-5'],
      [5, '2-5'],
      [6, '6-20'],
      [20, '6-20'],
      [21, '21-100'],
      [100, '21-100'],
      [101, '101+'],
      [1_000_000, '101+'],
    ]
    for (const [n, bucket] of cases) expect(countBucket(n)).toBe(bucket)
    for (const n of [0, 3, 8, 50, 500]) expect(COUNT_BUCKETS).toContain(countBucket(n))
  })
})

describe('createUsageTracker', () => {
  it('passes valid events to the sink and drops invalid ones with a code', async () => {
    const recorded: UsageEvent[] = []
    const errors: string[] = []
    const track = createUsageTracker({
      record: async (event) => {
        recorded.push(event)
      },
      onError: (code) => errors.push(code),
    })
    track('note.created', { from: 'duplicate' })
    // Untyped callers (or a cast) still go through the runtime check.
    ;(track as (name: string, properties: unknown) => void)('note.created', { from: 'My diary' })
    await Promise.resolve()
    expect(recorded).toEqual([{ name: 'note.created', properties: { from: 'duplicate' } }])
    expect(errors).toEqual(['E_USAGE_BAD_VALUE'])
  })

  it('never throws, even when the sink fails', async () => {
    const errors: string[] = []
    const track = createUsageTracker({
      record: () => Promise.reject(new Error('E_USAGE_STORE_FAILED: details')),
      onError: (code) => errors.push(code),
    })
    expect(() => track('note.created', { from: 'link' })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errors).toEqual(['W_USAGE_RECORD_FAILED'])
  })

  it('rejects content at the type level', () => {
    const errors: string[] = []
    const track = createUsageTracker({
      record: async () => {},
      onError: (code) => errors.push(code),
    })
    // @ts-expect-error a title is not one of the declared values
    track('note.created', { from: 'Meeting notes' })
    // @ts-expect-error properties outside the catalog are not allowed
    track('note.created', { from: 'link', title: 'Plan' })
    // @ts-expect-error a count must be a number
    track('search.run', { scope: 'all', clauses: '2', results: '0' })
    // @ts-expect-error results are a bucket, not a raw number
    track('search.run', { scope: 'all', clauses: 2, results: 7 })
    // @ts-expect-error events outside the catalog are not allowed
    track('note.opened', {})
    // The run-time check turns each of them away too.
    expect(errors).toEqual([
      'E_USAGE_BAD_VALUE',
      'E_USAGE_UNKNOWN_PROPERTY',
      'E_USAGE_BAD_VALUE',
      'E_USAGE_BAD_VALUE',
      'E_USAGE_UNKNOWN_EVENT',
    ])
  })
})

describe('usageCounts', () => {
  it('counts stored events by name, most frequent first', () => {
    const events: StoredUsageEvent[] = [
      { id: 1, at: 1, name: 'search.run', properties: {} },
      { id: 2, at: 2, name: 'note.created', properties: {} },
      { id: 3, at: 3, name: 'search.run', properties: {} },
      { id: 4, at: 4, name: 'import.finished', properties: {} },
    ]
    expect(usageCounts(events)).toEqual([
      { name: 'search.run', count: 2 },
      { name: 'import.finished', count: 1 },
      { name: 'note.created', count: 1 },
    ])
  })
})
