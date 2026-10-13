// Revision history rules: when the note service takes a version of a note's
// body, which versions compaction keeps, and how the history list reads.
//
// Versions are local to this device: they are not synced, and carry no HLC.

import { localDay as dayNumber, systemOffset } from './activity'
import type { RevisionKind, RevisionSummary } from './storage'

/** A version is taken once editing has paused this long... */
export const REVISION_PAUSE_MS = 60_000
/** ...or after this long of continuous editing. */
export const REVISION_EVERY_MS = 10 * 60_000
/** Compaction sweeps run at most this often (see compactionWindows). */
export const COMPACT_EVERY_MS = 60 * 60_000
/**
 * A note's newest versions, which compaction always keeps, whatever their
 * dates (see revisionsToDrop).
 */
export const KEEP_NEWEST = 10
/** Versions one storage call of a sweep deletes at most, so none holds the database long. */
export const COMPACT_BATCH = 200
/** Notes whose versions one storage call of a sweep lists at most (see listCompactable). */
export const COMPACT_PAGE = 500

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** The text's length in characters (code points), as history shows it. */
export function textLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * The value of a baseline: the body version that keeps the text a note had
 * when its history began (an import, devot-mcp, a duplicate, a note from
 * before history existed). That text was not written in this history, so
 * the activity heatmap never counts it, and compaction keeps the version.
 */
export const BASELINE = 'baseline'

/** The local calendar day of a time, as a key: the activity heatmap's day. */
const localDay = (at: number): string => String(dayNumber(at, systemOffset))

/**
 * The body versions compaction deletes: it keeps every version from the
 * last 24 hours, the last one of each hour for a week, and the last one of
 * each day before that. Metadata events are small and always kept, and so
 * is a baseline (see BASELINE), which counting activity measures from.
 *
 * Ages are measured by the system clock, which can be wrong, so they count
 * from `now` or from the note's newest version, whichever is earlier: the
 * spacing between versions taken at real times decides, and a clock that
 * runs fast (a session a day or more ahead, which would make the latest
 * work look old) cannot thin a note's last day of work. The note's
 * KEEP_NEWEST newest versions are always kept too, for a note with a
 * version taken while the clock ran fast. A note whose newest version is
 * dated after `now` is left alone: the clock was set back since that
 * version was taken, so ages measured by it mean nothing until it passes
 * it again.
 */
export function revisionsToDrop(
  revisions: readonly (Pick<RevisionSummary, 'id' | 'kind' | 'at'> &
    Partial<Pick<RevisionSummary, 'value'>>)[],
  now: number,
  dayOf: (at: number) => string = localDay,
): string[] {
  const kept = new Set<string>()
  const drop: string[] = []
  const newestFirst = revisions
    .filter((r) => r.kind === 'body' && r.value !== BASELINE)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
  const newest = newestFirst[0]?.at ?? now
  if (newest > now) return []
  newestFirst.forEach((revision, i) => {
    const age = newest - revision.at
    if (age < DAY) return
    const bucket = age < WEEK ? `h${Math.floor(revision.at / HOUR)}` : `d${dayOf(revision.at)}`
    if (kept.has(bucket) && i >= KEEP_NEWEST) drop.push(revision.id)
    else kept.add(bucket)
  })
  return drop
}

/**
 * The time ranges a compaction sweep asks storage about: notes with a body
 * version taken in a range, and more than one taken before its end, may
 * have versions to drop. The first sweep (`last` undefined: none ran on
 * this database yet, or the clock was set back past the last one) covers
 * every version older than a day. A later one covers only the versions
 * that turned a day or a week old since the sweep before, the only ages at
 * which `revisionsToDrop` keeps less. (It counts ages from a note's newest
 * version, so they change only when a version is taken, and the sweep
 * after that version turns a day old weighs the note with them.)
 */
export function compactionWindows(last: number | undefined, now: number): [number, number][] {
  const before = (at: number, age: number) => Math.max(0, at - age)
  if (last === undefined) return [[0, before(now, DAY)]]
  return [DAY, WEEK].map((age): [number, number] => [before(last, age), before(now, age)])
}

/** One line of a note's history, newest first. */
export type HistoryEntry =
  | {
      id: string
      kind: 'body'
      at: number
      /** The version's length in characters. */
      length: number
      /**
       * Characters gained (or lost, below zero) since the version before;
       * null for the oldest kept version, which has none to compare with.
       */
      change: number | null
    }
  | {
      id: string
      kind: Exclude<RevisionKind, 'body'>
      at: number
      value: string | null
    }

/** A note's revisions as its history lists them, newest first. */
export function historyEntries(revisions: readonly RevisionSummary[]): HistoryEntry[] {
  const oldestFirst = [...revisions].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  let previous: number | null = null
  const entries: HistoryEntry[] = []
  for (const r of oldestFirst) {
    if (r.kind === 'body') {
      const length = r.length ?? 0
      entries.push({
        id: r.id,
        kind: 'body',
        at: r.at,
        length,
        change: previous === null ? null : length - previous,
      })
      previous = length
    } else {
      entries.push({ id: r.id, kind: r.kind, at: r.at, value: r.value })
    }
  }
  return entries.reverse()
}
