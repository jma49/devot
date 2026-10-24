// Revision history rules: when the note service takes a version of a note's body, which versions compaction keeps, and how the history list reads.
//
// Versions are local to this device: they are not synced, and carry no HLC.

import { localDay as dayNumber, systemOffset } from './activity'
import type { RevisionKind, RevisionSummary } from './storage'

export const REVISION_PAUSE_MS = 60_000
export const REVISION_EVERY_MS = 10 * 60_000
export const COMPACT_EVERY_MS = 60 * 60_000
/** A note's newest versions, which compaction always keeps, whatever their dates. */
export const KEEP_NEWEST = 10
export const COMPACT_BATCH = 200
export const COMPACT_PAGE = 500

const HOUR = 3_600_000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export function textLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** The body version that keeps the text a note had when its history began (an import, devot-mcp, a duplicate, a note from before history). That text was not written in this history, so the activity heatmap never counts it, and compaction keeps it. */
export const BASELINE = 'baseline'

/** The body version an accepted AI edit proposal wrote (NoteService.applyAiEdit): its authorship. Like a baseline, the heatmap does not count it and compaction keeps it. */
export const AI_EDIT = 'ai'

/** The body version kept before a state from another device changed the note (sync, #216): Revision History labels it a merge, and either side of a merge can be restored from it. Compaction keeps it. */
export const MERGE = 'merge'

const localDay = (at: number): string => String(dayNumber(at, systemOffset))

/**
 * Keeps every version from the last 24 hours, the last of each hour for a week, and the last of each day before that. Metadata events and marked versions (a
 * baseline, an AI edit) are always kept.
 *
 * Ages count from `now` or from the note's newest version, whichever is earlier: the system clock can be wrong, and one running fast (a session a day or more ahead)
 * must not thin a note's last day of work. The KEEP_NEWEST newest versions are always kept too. A note whose newest version is dated after `now` is left alone: the
 * clock was set back since, so ages measured by it mean nothing until it passes that version again.
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
    .filter((r) => r.kind === 'body' && (r.value ?? null) === null)
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

/** A sweep asks about notes with a body version taken in a range and more than one taken before its end. The first sweep (`last` undefined: none ran yet, or the clock was set back past the last) covers every version older than a day; a later one only versions that turned a day or a week old since, the only ages at which `revisionsToDrop` keeps less. */
export function compactionWindows(last: number | undefined, now: number): [number, number][] {
  const before = (at: number, age: number) => Math.max(0, at - age)
  if (last === undefined) return [[0, before(now, DAY)]]
  return [DAY, WEEK].map((age): [number, number] => [before(last, age), before(now, age)])
}

export type HistoryEntry =
  | {
      id: string
      kind: 'body'
      at: number
      length: number
      /** Null for the oldest kept version. */
      change: number | null
      /** Written by an accepted AI edit (AI_EDIT). */
      ai?: true
      /** The text this device had before a merge with another device's (MERGE). */
      merge: boolean
    }
  | {
      id: string
      kind: Exclude<RevisionKind, 'body'>
      at: number
      value: string | null
    }

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
        ...(r.value === AI_EDIT ? { ai: true as const } : {}),
        merge: r.value === MERGE,
      })
      previous = length
    } else {
      entries.push({ id: r.id, kind: r.kind, at: r.at, value: r.value })
    }
  }
  return entries.reverse()
}
