// The activity heatmap: how much was written on each local day of the last
// 52 weeks, counted from what storage already keeps (notes, and the
// revision history), on this device only.
//
// A day counts the notes created that day, the notes edited that day (each
// once: a body version or a title change), and the characters changed: how
// far a note's text length moved from its body version before (from empty
// for its first) to each version taken that day. A baseline, the text a
// note had before its history began, is not one (storage leaves it out; see
// BASELINE in revisions.ts): only the next version is measured from it.
// Typing not kept as a version yet is kept first (NoteService.activity),
// as it is on quit, so it counts on the day it was typed. Compaction keeps one
// version per day for older history (see revisions.ts), so older days count
// the net change of each note over the day, never more than was typed.

import type { ActivityData, StorageAdapter } from './storage'

export const DAY_MS = 86_400_000
/** Weeks the heatmap shows; the last one is the week of today. */
export const HEATMAP_WEEKS = 52
/** Shades of activity: 0 for an idle day, then 1 (least) to 4 (most). */
export const ACTIVITY_LEVELS = 4

/** A zone's offset from UTC at an instant, in minutes (east positive). */
export type OffsetAt = (at: number) => number

/** The offset of the system's time zone (the one `Intl` reports). */
export const systemOffset: OffsetAt = (at) => -new Date(at).getTimezoneOffset()

/**
 * The local calendar day of an instant, as a day number: days since
 * 1970-01-01 on the wall clock of the zone. Every instant falls on the day
 * its zone shows, so DST days of 23 or 25 hours need no special case.
 */
export function localDay(at: number, offsetAt: OffsetAt): number {
  return Math.floor((at + offsetAt(at) * 60_000) / DAY_MS)
}

/** The weekday of a day number: Monday 0 ... Sunday 6. */
export function weekday(day: number): number {
  return (((day + 3) % 7) + 7) % 7
}

/** The heatmap's first day: the Monday HEATMAP_WEEKS - 1 weeks before today's week. */
export function heatmapStart(today: number): number {
  return today - weekday(today) - (HEATMAP_WEEKS - 1) * 7
}

/**
 * The instant to ask storage from: a day before the first day's midnight
 * in UTC, earlier than that midnight in any zone (offsets stay within a
 * day). What falls before the first day is left out when counting.
 */
export function activitySince(first: number): number {
  return Math.max(0, (first - 1) * DAY_MS)
}

export interface DayActivity {
  /** The local day number (see localDay). */
  day: number
  /** Notes created that day. */
  created: number
  /** Notes edited that day, each counted once. */
  edited: number
  /** Characters changed that day, added and removed. */
  chars: number
  /** Its shade: 0 for an idle day, then 1 to ACTIVITY_LEVELS. */
  level: number
}

export interface ActivityHeatmap {
  /** The first day shown, a Monday. */
  first: number
  /** Today; the days after it in its week are not shown. */
  today: number
  /** Every day from `first` to `today`, in order. */
  days: DayActivity[]
  total: { created: number; chars: number; activeDays: number }
}

/**
 * The shade of each day: 0 when idle; otherwise by how its characters
 * changed rank among the days that changed any (a percentile, so the shades
 * spread evenly and the busiest day takes ACTIVITY_LEVELS); a day with
 * activity but no characters changed (a new empty note, a rename) takes 1.
 */
function shade(days: DayActivity[]): void {
  const written = days
    .map((d) => d.chars)
    .filter((chars) => chars > 0)
    .sort((a, b) => a - b)
  /** How many written days changed at most `chars` characters. */
  const rank = (chars: number) => {
    let lo = 0
    let hi = written.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (written[mid]! <= chars) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  for (const day of days) {
    if (day.created + day.edited + day.chars === 0) day.level = 0
    else if (day.chars === 0) day.level = 1
    else day.level = Math.max(1, Math.ceil((ACTIVITY_LEVELS * rank(day.chars)) / written.length))
  }
}

/** Counts `data` per local day for the heatmap ending today (see the top of this file). */
export function buildHeatmap(
  data: ActivityData,
  now: number,
  offsetAt: OffsetAt = systemOffset,
): ActivityHeatmap {
  const today = localDay(now, offsetAt)
  const first = heatmapStart(today)
  const days: DayActivity[] = Array.from({ length: today - first + 1 }, (_, i) => ({
    day: first + i,
    created: 0,
    edited: 0,
    chars: 0,
    level: 0,
  }))
  const edited = new Map<number, Set<string>>()
  /** The day at `at`, if the heatmap shows it. */
  const dayAt = (at: number): DayActivity | undefined => days[localDay(at, offsetAt) - first]
  const edit = (noteId: string, at: number, chars: number) => {
    const day = dayAt(at)
    if (!day) return
    day.chars += chars
    let notes = edited.get(day.day)
    if (!notes) edited.set(day.day, (notes = new Set()))
    notes.add(noteId)
  }

  for (const revision of data.revisions) {
    const chars =
      revision.kind === 'body' ? Math.abs((revision.length ?? 0) - (revision.previous ?? 0)) : 0
    edit(revision.noteId, revision.at, chars)
  }
  for (const note of data.notes) {
    const created = dayAt(note.createdAt)
    if (created) created.created += 1
  }

  for (const day of days) day.edited = edited.get(day.day)?.size ?? 0
  shade(days)
  const total = { created: 0, chars: 0, activeDays: 0 }
  for (const day of days) {
    total.created += day.created
    total.chars += day.chars
    if (day.level > 0) total.activeDays += 1
  }
  return { first, today, days, total }
}

/** Reads storage and counts the heatmap ending today. */
export async function loadActivity(
  storage: Pick<StorageAdapter, 'listActivity'>,
  now: number,
  offsetAt: OffsetAt = systemOffset,
): Promise<ActivityHeatmap> {
  const since = activitySince(heatmapStart(localDay(now, offsetAt)))
  return buildHeatmap(await storage.listActivity(since), now, offsetAt)
}
