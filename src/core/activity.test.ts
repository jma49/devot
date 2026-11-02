import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_LEVELS,
  activitySince,
  buildHeatmap,
  buildWriting,
  dailyWords,
  DAY_MS,
  dayStreak,
  HEATMAP_WEEKS,
  heatmapStart,
  localDay,
  mostEdited,
  notesEdited,
  weekday,
  weekSpan,
  wordsIn,
  type OffsetAt,
} from './activity'
import type { ActivityData, ActivityRevision } from './storage'

function zoneOffset(timeZone: string): OffsetAt {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  })
  return (at) => {
    const part = new Map(format.formatToParts(at).map((p) => [p.type, Number(p.value)]))
    const wall = Date.UTC(
      part.get('year') ?? 1970,
      (part.get('month') ?? 1) - 1,
      part.get('day') ?? 1,
      part.get('hour') ?? 0,
      part.get('minute') ?? 0,
      part.get('second') ?? 0,
    )
    return Math.round((wall - Math.floor(at / 1000) * 1000) / 60_000)
  }
}

const HOUR = 3_600_000

const dayOf = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / DAY_MS

const at = (iso: string) => Date.parse(iso)

const UTC: OffsetAt = () => 0
const LA = zoneOffset('America/Los_Angeles')
const SHANGHAI = zoneOffset('Asia/Shanghai')
const KATHMANDU = zoneOffset('Asia/Kathmandu')

describe('zone offsets', () => {
  it('follow Los Angeles across both DST transitions of 2026', () => {
    // Clocks go forward at 2:00 PST on March 8 (10:00 UTC)...
    expect(LA(at('2026-03-08T09:59:59Z'))).toBe(-480)
    expect(LA(at('2026-03-08T10:00:00Z'))).toBe(-420)
    // ...and back at 2:00 PDT on November 1 (09:00 UTC).
    expect(LA(at('2026-11-01T08:59:59Z'))).toBe(-420)
    expect(LA(at('2026-11-01T09:00:00Z'))).toBe(-480)
  })

  it('are fixed for Shanghai and a quarter-hour zone', () => {
    for (const iso of ['2026-01-15T00:00:00Z', '2026-07-15T12:34:56Z']) {
      expect(SHANGHAI(at(iso))).toBe(480)
      expect(KATHMANDU(at(iso))).toBe(345)
    }
  })
})

describe('local days', () => {
  it('number calendar days from 1970-01-01 and know their weekday', () => {
    expect(localDay(at('1970-01-01T00:00:00Z'), UTC)).toBe(0)
    expect(localDay(at('2026-10-07T23:59:59Z'), UTC)).toBe(dayOf(2026, 10, 7))
    // Monday is 0 ... Sunday 6; 2026-10-05 is a Monday.
    expect(weekday(dayOf(2026, 10, 5))).toBe(0)
    expect(weekday(dayOf(2026, 10, 11))).toBe(6)
    expect(weekday(0)).toBe(3)
  })

  it('keep the whole 23-hour day when Los Angeles springs forward', () => {
    const march8 = dayOf(2026, 3, 8)
    expect(localDay(at('2026-03-08T00:00:00-08:00'), LA)).toBe(march8)
    expect(localDay(at('2026-03-08T01:59:59-08:00'), LA)).toBe(march8)
    expect(localDay(at('2026-03-08T03:00:00-07:00'), LA)).toBe(march8)
    expect(localDay(at('2026-03-08T23:59:59-07:00'), LA)).toBe(march8)
    expect(localDay(at('2026-03-09T00:00:00-07:00'), LA)).toBe(march8 + 1)
    expect(localDay(at('2026-03-07T23:59:59-08:00'), LA)).toBe(march8 - 1)
  })

  it('keep the whole 25-hour day when Los Angeles falls back', () => {
    const nov1 = dayOf(2026, 11, 1)
    expect(localDay(at('2026-11-01T00:00:00-07:00'), LA)).toBe(nov1)
    // 1:30 happens twice; both are November 1.
    expect(localDay(at('2026-11-01T01:30:00-07:00'), LA)).toBe(nov1)
    expect(localDay(at('2026-11-01T01:30:00-08:00'), LA)).toBe(nov1)
    expect(localDay(at('2026-11-01T23:59:59-08:00'), LA)).toBe(nov1)
    expect(localDay(at('2026-11-02T00:00:00-08:00'), LA)).toBe(nov1 + 1)
    expect(localDay(at('2026-10-31T23:59:59-07:00'), LA)).toBe(nov1 - 1)
  })

  it('put the same instant on the day each zone sees', () => {
    const late = at('2026-10-06T18:10:00Z')
    const later = at('2026-10-06T18:20:00Z')
    expect(localDay(late, KATHMANDU)).toBe(dayOf(2026, 10, 6)) // 23:55
    expect(localDay(later, KATHMANDU)).toBe(dayOf(2026, 10, 7)) // 00:05
    expect(localDay(late, SHANGHAI)).toBe(dayOf(2026, 10, 7)) // 02:10
    expect(localDay(at('2026-10-06T15:59:59Z'), SHANGHAI)).toBe(dayOf(2026, 10, 6))
    expect(localDay(later, LA)).toBe(dayOf(2026, 10, 6)) // 11:20
  })
})

describe('the heatmap grid', () => {
  it('shows 52 weeks, Monday first, ending with the week of today', () => {
    const wednesday = dayOf(2026, 10, 7)
    const first = heatmapStart(wednesday)
    expect(weekday(first)).toBe(0)
    expect(first).toBe(dayOf(2026, 10, 5) - (HEATMAP_WEEKS - 1) * 7)
    // On a Monday the last week holds only today.
    expect(heatmapStart(dayOf(2026, 10, 5))).toBe(first)
    expect(heatmapStart(dayOf(2026, 10, 11))).toBe(first)
    expect(heatmapStart(dayOf(2026, 10, 12))).toBe(first + 7)
  })

  it('asks storage from early enough for every zone', () => {
    const first = dayOf(2026, 1, 5)
    // Local midnight of `first` is never earlier than this, anywhere.
    expect(activitySince(first)).toBeLessThanOrEqual(first * DAY_MS - 14 * HOUR)
    expect(activitySince(first)).toBeGreaterThan(first * DAY_MS - 2 * DAY_MS)
  })
})

const note = (id: string, createdAt: number) => ({ id, createdAt })
const body = (noteId: string, when: number, length: number, previous: number | null) =>
  ({
    noteId,
    kind: 'body',
    at: when,
    length,
    words: null,
    previous,
    previousWords: null,
  }) satisfies ActivityRevision
const title = (noteId: string, when: number) =>
  ({
    noteId,
    kind: 'title',
    at: when,
    length: null,
    words: null,
    previous: null,
    previousWords: null,
  }) satisfies ActivityRevision

describe('counting activity per day', () => {
  const today = dayOf(2026, 10, 7)
  const now = today * DAY_MS + 15 * HOUR
  const noon = (day: number) => day * DAY_MS + 12 * HOUR
  const build = (data: Partial<ActivityData>, offset: OffsetAt = UTC) =>
    buildHeatmap({ notes: [], revisions: [], ...data }, now, offset)
  const dayIn = (heatmap: ReturnType<typeof build>, day: number) => {
    const found = heatmap.days.find((d) => d.day === day)
    if (!found) throw new Error(`no day ${day}`)
    return found
  }

  it('lists every day from the first Monday to today, idle days empty', () => {
    const heatmap = build({})
    expect(heatmap.today).toBe(today)
    expect(heatmap.first).toBe(heatmapStart(today))
    expect(heatmap.days.map((d) => d.day)).toEqual(
      Array.from({ length: today - heatmap.first + 1 }, (_, i) => heatmap.first + i),
    )
    expect(heatmap.days.every((d) => d.created + d.edited + d.chars + d.level === 0)).toBe(true)
    expect(heatmap.total).toEqual({ created: 0, chars: 0, activeDays: 0 })
  })

  it('counts notes created each day, and none before the grid', () => {
    const heatmap = build({
      notes: [
        note('a', noon(today - 2)),
        note('b', noon(today - 2) + HOUR),
        note('c', noon(today)),
        note('old', noon(heatmapStart(today) - 1)),
      ],
    })
    expect(dayIn(heatmap, today - 2).created).toBe(2)
    expect(dayIn(heatmap, today).created).toBe(1)
    expect(heatmap.total.created).toBe(3)
    // An empty note made and left is creation, not writing.
    expect(dayIn(heatmap, today).edited).toBe(0)
  })

  it('counts each edited note once a day, from its versions and title changes', () => {
    const day = today - 3
    const heatmap = build({
      revisions: [
        body('a', noon(day), 10, null),
        body('a', noon(day) + HOUR, 25, 10),
        title('a', noon(day) + 2 * HOUR),
        title('b', noon(day)),
        body('c', noon(day + 1), 4, 9),
      ],
    })
    expect(dayIn(heatmap, day)).toMatchObject({ edited: 2, chars: 10 + 15 })
    expect(dayIn(heatmap, day + 1)).toMatchObject({ edited: 1, chars: 5 })
  })

  it('buckets by the local day of the given zone', () => {
    // 23:30 in Los Angeles on October 5 is October 6 in Shanghai.
    const when = at('2026-10-05T23:30:00-07:00')
    const data = { revisions: [body('a', when, 7, null)] }
    expect(dayIn(build(data, LA), dayOf(2026, 10, 5)).chars).toBe(7)
    expect(dayIn(build(data, SHANGHAI), dayOf(2026, 10, 6)).chars).toBe(7)
    expect(dayIn(build(data, SHANGHAI), dayOf(2026, 10, 5)).chars).toBe(0)
  })

  it('ignores what falls before the grid or after today', () => {
    const heatmap = build({
      notes: [note('a', noon(today + 1))],
      revisions: [
        body('a', noon(heatmapStart(today) - 1), 50, null),
        body('a', noon(today + 1), 60, 50),
      ],
    })
    expect(heatmap.total).toEqual({ created: 0, chars: 0, activeDays: 0 })
  })

  it('shades days by how their characters changed rank, the busiest darkest', () => {
    const heatmap = build({
      revisions: [
        body('a', noon(today - 1), 5_000, 0),
        body('b', noon(today - 2), 1, 0),
        body('c', noon(today - 3), 70, 0),
        body('d', noon(today - 4), 900, 0),
        title('e', noon(today - 5)),
      ],
    })
    const level = (day: number) => dayIn(heatmap, day).level
    expect(level(today)).toBe(0)
    expect(level(today - 1)).toBe(4)
    expect(level(today - 5)).toBe(1)
    const levels = [level(today - 2), level(today - 3), level(today - 4), level(today - 1)]
    expect([...levels].sort()).toEqual(levels)
    expect(levels).toEqual([1, 2, 3, 4])
    expect(heatmap.total).toEqual({ created: 0, chars: 5_971, activeDays: 5 })
  })

  it('gives equal days the same shade, and a lone written day the darkest', () => {
    const same = build({
      revisions: [body('a', noon(today - 1), 10, 0), body('b', noon(today - 2), 10, 0)],
    })
    expect(same.days.filter((d) => d.level > 0).map((d) => d.level)).toEqual([4, 4])
    const lone = build({ revisions: [body('a', noon(today), 3, 0)] })
    expect(lone.days.at(-1)?.level).toBe(4)
  })
})

describe('counting words for the phone', () => {
  const zone: OffsetAt = () => 0
  const today = dayOf(2026, 10, 7) // a Wednesday
  const now = today * DAY_MS + 12 * 3_600_000
  const earlyOn = (day: number) => day * DAY_MS + 3_600_000
  const version = (
    noteId: string,
    day: number,
    words: number | null,
    previousWords: number | null,
    previous: number | null = previousWords,
  ): ActivityRevision => ({
    noteId,
    kind: 'body',
    at: earlyOn(day),
    length: (words ?? 0) * 5,
    words,
    previous,
    previousWords,
  })
  const monday = today - 2
  const data = (
    revisions: ActivityRevision[],
    notes: { id: string; createdAt: number }[] = [],
  ) => ({
    notes,
    revisions,
  })

  it('counts a day by how far words moved, from empty for a first version', () => {
    const { days } = buildHeatmap(
      data([version('a', today, 10, null), version('a', today, 4, 10)]),
      now,
      zone,
    )
    expect(days.at(-1)!.words).toBe(16)
  })

  it('counts no words for a version from before v24, nor for the first one after it', () => {
    const old = version('a', today, null, null, 400)
    const firstAfter = version('b', today, 90, null, 400)
    const next = version('b', today, 95, 90)
    const { days } = buildHeatmap(data([old, firstAfter, next]), now, zone)
    expect(days.at(-1)!.words).toBe(5)
    expect(days.at(-1)!.edited).toBe(2)
    expect(mostEdited([old, firstAfter, next], weekSpan(today, 'this'), zone)).toEqual([
      { noteId: 'b', words: 5 },
    ])
  })

  it('takes 15 weeks ending today, shaded by words among those days', () => {
    const days = dailyWords(
      buildHeatmap(
        data([version('a', today, 100, null), version('b', today - 1, 1, null)]),
        now,
        zone,
      ),
    )
    expect(days).toHaveLength(14 * 7 + 3)
    expect(days[0]!.day).toBe(monday - 14 * 7)
    expect(weekday(days[0]!.day)).toBe(0)
    expect(days.at(-1)!.level).toBe(ACTIVITY_LEVELS)
    expect(days.at(-2)!.level).toBe(2)
    expect(days[0]!.level).toBe(0)
  })

  it('leaves out a shade for a day older than the 15 weeks', () => {
    const old = version('a', monday - 15 * 7, 9000, null)
    const days = dailyWords(buildHeatmap(data([old, version('a', today, 1, null)]), now, zone))
    expect(days.at(-1)!.level).toBe(ACTIVITY_LEVELS)
  })

  it('spans this week to today and last week whole', () => {
    expect(weekSpan(today, 'this')).toEqual({ from: monday, to: today })
    expect(weekSpan(today, 'last')).toEqual({
      from: monday - 7,
      to: monday - 1,
    })
  })

  it('adds up a span of words, and only that span', () => {
    const { days } = buildHeatmap(
      data([version('a', monday - 1, 7, null), version('a', monday, 10, 7)]),
      now,
      zone,
    )
    expect(wordsIn(days, weekSpan(today, 'this'))).toBe(3)
    expect(wordsIn(days, weekSpan(today, 'last'))).toBe(7)
  })

  it('counts a streak back from today, which may still be empty', () => {
    const day = (n: number, edited = 1) => ({
      day: n,
      created: 0,
      edited,
      chars: 0,
      words: 0,
      level: 0,
    })
    const yesterday = [day(today - 3), day(today - 2, 0), day(today - 1)]
    expect(dayStreak(yesterday, today, today)).toBe(1)
    expect(dayStreak([...yesterday, day(today)], today, today)).toBe(2)
    expect(dayStreak(yesterday, today - 2, today)).toBe(0)
    expect(dayStreak(yesterday, today - 3, today)).toBe(1)
    expect(dayStreak([], today, today)).toBe(0)
  })

  it('counts a created note towards a streak', () => {
    const { days } = buildHeatmap(data([], [{ id: 'n', createdAt: earlyOn(today) }]), now, zone)
    expect(dayStreak(days, today, today)).toBe(1)
  })

  it('counts each edited note once in a span, a rename too', () => {
    const revisions = [
      version('a', monday, 5, null),
      version('a', today, 6, 5),
      { ...version('b', today, null, null), kind: 'title' as const },
      version('c', monday - 1, 5, null),
    ]
    expect(notesEdited(revisions, weekSpan(today, 'this'), zone)).toBe(2)
  })

  it('ranks notes by net growth and leaves out those that did not grow', () => {
    const revisions = [
      version('small', today, 5, null),
      version('big', monday, 100, 40),
      version('big', today, 90, 100),
      version('shrunk', today, 1, 50),
      version('before', monday - 1, 900, null),
    ]
    expect(mostEdited(revisions, weekSpan(today, 'this'), zone)).toEqual([
      { noteId: 'big', words: 50 },
      { noteId: 'small', words: 5 },
    ])
  })

  it('gives each week its own stats', () => {
    const writing = buildWriting(
      data([version('a', monday - 1, 8, null), version('a', today, 10, 8)]),
      now,
      zone,
    )
    expect(writing.first).toBe(monday - 14 * 7)
    expect(writing.weeks.this).toEqual({
      words: 2,
      streak: 1,
      notesEdited: 1,
      mostEdited: [{ noteId: 'a', words: 2 }],
    })
    expect(writing.weeks.last).toEqual({
      words: 8,
      streak: 1,
      notesEdited: 1,
      mostEdited: [{ noteId: 'a', words: 8 }],
    })
  })
})
