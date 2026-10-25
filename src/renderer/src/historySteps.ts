import type { HistoryEntry } from '../../core'
import type { TextSegment } from '../../core/diff'

export interface HistoryStep {
  id: string
  at: number
  length: number
  /** Null for the oldest kept version (see HistoryEntry). */
  change: number | null
  /** Characters changed from the version before (see versionChanges), else the change in length; null for the oldest kept. */
  chars: number | null
}

const DAY = 86_400_000
const PAGE = 10
const LOWEST_TICK = 0.2

export function historySteps(
  entries: readonly HistoryEntry[],
  changes: Readonly<Record<string, number>> = {},
): HistoryStep[] {
  const steps: HistoryStep[] = []
  for (const e of entries) {
    if (e.kind !== 'body') continue
    steps.push({
      id: e.id,
      at: e.at,
      length: e.length,
      change: e.change,
      chars: e.change === null ? null : (changes[e.id] ?? Math.abs(e.change)),
    })
  }
  return steps.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
}

export function axisAt(at: number, start: number, end: number): number {
  if (end <= start) return 1
  return Math.min(1, Math.max(0, (at - start) / (end - start)))
}

/** The step nearest `fraction` of the axis: an index into `steps`, or `steps.length` for the current text at the axis's end. */
export function stepNearest(
  fraction: number,
  steps: readonly HistoryStep[],
  start: number,
  end: number,
): number {
  let best = steps.length
  let distance = Math.abs(1 - fraction)
  steps.forEach((step, i) => {
    const d = Math.abs(axisAt(step.at, start, end) - fraction)
    if (d < distance) {
      best = i
      distance = d
    }
  })
  return best
}

/** A tick's height as a share of the bar's: by the square root, so a small edit still shows beside a large one. The oldest kept is lowest. */
export function tickHeight(chars: number | null, most: number): number {
  if (chars === null || most <= 0) return LOWEST_TICK
  return LOWEST_TICK + (1 - LOWEST_TICK) * Math.sqrt(Math.min(chars, most) / most)
}

/** Compaction keeps every version for a day only (revisions.ts): older history is thinned. */
export function compactionLimited(steps: readonly HistoryStep[], now: number): boolean {
  return steps.some((s) => s.at < now - DAY)
}

/** The step a slider key moves to from `value`, in 0 (the oldest version) to `last` (the current text). */
export function scrubKey(key: string, value: number, last: number): number | undefined {
  const to = (n: number) => Math.min(last, Math.max(0, n))
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return to(value - 1)
    case 'ArrowRight':
    case 'ArrowUp':
      return to(value + 1)
    case 'PageDown':
      return to(value - PAGE)
    case 'PageUp':
      return to(value + PAGE)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return undefined
  }
}

/** Where each segment starts in the version's text (an added run takes none of it). */
function starts(segments: readonly TextSegment[]): number[] {
  let at = 0
  return segments.map((s) => {
    const start = at
    if (s.kind !== 'added') at += s.text.length
    return start
  })
}

/** A point `offset` characters into segment `index`, as an offset in the version's text. */
export function pastOffset(
  segments: readonly TextSegment[],
  index: number,
  offset: number,
): number {
  const start = starts(segments)[index] ?? 0
  return segments[index]?.kind === 'added' ? start : start + offset
}

export function removedWithin(segments: readonly TextSegment[], from: number, to: number): boolean {
  if (from >= to) return false
  const at = starts(segments)
  return segments.some((s, i) => {
    const start = at[i] ?? 0
    return s.kind === 'removed' && start < to && from < start + s.text.length
  })
}
