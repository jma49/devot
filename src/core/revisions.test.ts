import { describe, expect, it } from 'vitest'
import {
  BASELINE,
  compactionWindows,
  historyEntries,
  KEEP_NEWEST,
  MERGE,
  revisionsToDrop,
  textLength,
} from './revisions'
import type { RevisionSummary } from './storage'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Noon UTC: every time zone puts the minutes around it on one local day.
const NOW = Date.UTC(2026, 9, 10, 12)

let n = 0
const body = (at: number, length = 1): RevisionSummary => ({
  id: `r${(n += 1)}`,
  noteId: 'n',
  kind: 'body',
  at,
  length,
  value: null,
})

/** All from the last hour: compaction always keeps them, so the rules for older versions show beside them. */
const newest = () => Array.from({ length: KEEP_NEWEST }, (_, i) => body(NOW - (i + 1) * 60_000))

describe('revisionsToDrop', () => {
  it('keeps every version from the last 24 hours', () => {
    const recent = [NOW - 60_000, NOW - 2 * 60_000, NOW - 10 * HOUR, NOW - 23 * HOUR].map((at) =>
      body(at),
    )
    expect(revisionsToDrop(recent, NOW)).toEqual([])
  })

  it('keeps the last version of each hour for a week', () => {
    const lastInHour = body(NOW - 2 * DAY + 50 * 60_000)
    const earlier = body(NOW - 2 * DAY + 10 * 60_000)
    const nextHour = body(NOW - 2 * DAY + 70 * 60_000)
    expect(revisionsToDrop([...newest(), earlier, lastInHour, nextHour], NOW)).toEqual([earlier.id])
  })

  it('keeps the last version of each day after a week', () => {
    const day = NOW - 30 * DAY
    const morning = body(day - 2 * HOUR)
    const evening = body(day + 20 * 60_000)
    const before = body(day - DAY)
    const utcDay = (at: number) => String(Math.floor(at / DAY))
    expect(revisionsToDrop([...newest(), evening, morning, before], NOW, utcDay)).toEqual([
      morning.id,
    ])
  })

  it('measures ages from the note’s newest version, so a fast clock thins none of its last day', () => {
    // The clock reads eight days later than the last day of writing: it ran
    // fast. That day is still the note's latest, and all of it stays.
    const fast = NOW + 8 * DAY
    const day = Array.from({ length: KEEP_NEWEST + 2 }, (_, i) => body(NOW - i * HOUR))
    const utcDay = (at: number) => String(Math.floor(at / DAY))
    expect(revisionsToDrop(day, fast, utcDay)).toEqual([])
  })

  it('always keeps a note’s newest versions, whatever their dates', () => {
    // One version typed while the clock ran eight days fast: the day before
    // it looks a week old, but its newest versions all stay.
    const fast = NOW + 8 * DAY
    const day = Array.from({ length: KEEP_NEWEST }, (_, i) => body(NOW - i * HOUR))
    const utcDay = (at: number) => String(Math.floor(at / DAY))
    expect(revisionsToDrop([body(fast), ...day], fast, utcDay)).toEqual([day.at(-1)!.id])
    expect(revisionsToDrop([body(fast), ...day.slice(1)], fast, utcDay)).toEqual([])
  })

  it('drops nothing while the clock reads earlier than the newest version', () => {
    // A version taken while the clock ran a week fast; it has been set back.
    const ahead = body(NOW + 7 * DAY)
    const old = [...newest(), body(NOW - 3 * DAY), body(NOW - 3 * DAY + 60_000)]
    expect(revisionsToDrop([ahead, ...old], NOW)).toEqual([])
    // Once the clock passes it again, the old versions are thinned as usual.
    expect(revisionsToDrop([ahead, ...old], NOW + 7 * DAY)).not.toEqual([])
  })

  it('leaves metadata events alone', () => {
    const old = NOW - 40 * DAY
    const events: RevisionSummary[] = [
      { id: 'e1', noteId: 'n', kind: 'title', at: old, length: null, value: 'A' },
      { id: 'e2', noteId: 'n', kind: 'title', at: old + 1, length: null, value: 'B' },
    ]
    expect(revisionsToDrop(events, NOW)).toEqual([])
  })

  it('keeps a baseline, and the day’s last version beside it', () => {
    const day = NOW - 30 * DAY
    const baseline = { ...body(day - 2 * HOUR), value: BASELINE }
    const morning = body(day - HOUR)
    const evening = body(day + 20 * 60_000)
    const utcDay = (at: number) => String(Math.floor(at / DAY))
    expect(revisionsToDrop([...newest(), evening, morning, baseline], NOW, utcDay)).toEqual([
      morning.id,
    ])
  })
})

describe('compactionWindows', () => {
  it('covers every version older than a day on the first sweep of a session', () => {
    expect(compactionWindows(undefined, NOW)).toEqual([[0, NOW - DAY]])
  })

  it('then covers the versions that turned a day or a week old since', () => {
    const last = NOW - 2 * HOUR
    expect(compactionWindows(last, NOW)).toEqual([
      [last - DAY, NOW - DAY],
      [last - 7 * DAY, NOW - 7 * DAY],
    ])
  })

  it('never reaches before the epoch', () => {
    expect(compactionWindows(undefined, HOUR)).toEqual([[0, 0]])
    expect(compactionWindows(HOUR, 2 * HOUR)).toEqual([
      [0, 0],
      [0, 0],
    ])
  })
})

describe('historyEntries', () => {
  it('lists newest first with the change in length since the version before', () => {
    const first = body(NOW - 3 * HOUR, 10)
    const event: RevisionSummary = {
      id: 'e',
      noteId: 'n',
      kind: 'pinned',
      at: NOW - 2 * HOUR,
      length: null,
      value: '1',
    }
    const second = body(NOW - HOUR, 4)
    expect(historyEntries([second, first, event])).toEqual([
      { id: second.id, kind: 'body', at: second.at, length: 4, change: -6, merge: false },
      { id: 'e', kind: 'pinned', at: event.at, value: '1' },
      { id: first.id, kind: 'body', at: first.at, length: 10, change: null, merge: false },
    ])
  })

  it('labels the version kept before a sync merge', () => {
    const kept = { ...body(NOW - HOUR, 4), value: MERGE }
    expect(historyEntries([kept, body(NOW - 2 * HOUR, 3)])[0]).toMatchObject({
      id: kept.id,
      change: 1,
      merge: true,
    })
  })

  it('gives the oldest kept version no change, even after an event or with no text', () => {
    const event: RevisionSummary = {
      id: 'e',
      noteId: 'n',
      kind: 'title',
      at: NOW - 3 * HOUR,
      length: null,
      value: 'Plan',
    }
    const empty = body(NOW - 2 * HOUR, 0)
    const next = body(NOW - HOUR, 0)
    const last = body(NOW, 5)
    const lines = historyEntries([last, event, next, empty])
    expect(lines.map((e) => (e.kind === 'body' ? e.change : e.kind))).toEqual([5, 0, null, 'title'])
  })
})

describe('textLength', () => {
  it('counts characters, not UTF-16 units', () => {
    expect(textLength('a\u{1F600}b')).toBe(3)
  })
})
