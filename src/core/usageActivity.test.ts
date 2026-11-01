import { describe, expect, it } from 'vitest'
import { usageActivity } from './usageActivity'
import type { StoredUsageEvent } from './usage'

const now = Date.UTC(2026, 10, 1, 20)
const event = (id: number, at: number, name = 'note.created'): StoredUsageEvent => ({
  id,
  at,
  name,
  properties: {},
})

describe('usageActivity', () => {
  it('counts local calendar days, includes the first midnight and ignores future and older events', () => {
    const start = Date.UTC(2026, 9, 26)
    const data = usageActivity(
      [event(1, start), event(2, start - 1), event(3, now), event(4, now + 1)],
      now,
      7,
      '',
      () => 0,
    )
    expect(data.total).toBe(2)
    expect(data.activeDays).toBe(2)
    expect(data.days).toHaveLength(7)
    expect(data.days[0]?.count).toBe(1)
    expect(data.days[6]?.count).toBe(1)
    expect(data.hours.flat().reduce((a, b) => a + b, 0)).toBe(2)
  })

  it('filters every chart and preserves unknown event types', () => {
    const events = [event(1, now), event(2, now, 'search.run'), event(3, now, 'new.event')]
    expect(usageActivity(events, now, 30, 'search.run', () => 0)).toMatchObject({
      total: 1,
      notes: 0,
      counts: [{ name: 'search.run', count: 1 }],
    })
    expect(usageActivity(events, now, 30, '', () => 0).counts).toContainEqual({
      name: 'new.event',
      count: 1,
    })
  })

  it('uses the offset at each event for DST, repeated hours and local midnight', () => {
    const before = Date.UTC(2026, 10, 1, 8, 30)
    const after = Date.UTC(2026, 10, 1, 9, 30)
    const offset = (at: number) => (at < Date.UTC(2026, 10, 1, 9) ? -420 : -480)
    const data = usageActivity([event(1, before), event(2, after)], now, 7, '', offset)
    expect(data.hours[6]?.[1]).toBe(2)
    expect(data.activeDays).toBe(1)
    expect(data.days.at(-1)?.count).toBe(2)
  })

  it('keeps empty periods finite, with every weekday and hour represented', () => {
    const data = usageActivity([], now, 90, '', () => 0)
    expect(data).toMatchObject({ total: 0, notes: 0, activeDays: 0, average: 0, peak: null })
    expect(data.hours).toHaveLength(7)
    expect(data.hours.every((row) => row.length === 24)).toBe(true)
    expect(data.days).toHaveLength(90)
  })
})
