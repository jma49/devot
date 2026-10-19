// Windowing for long note lists: only the entries near the visible part of
// the list are rendered; spacers stand for the rest. Positions come from the
// entries' measured heights (estimated until they have been rendered once).

/**
 * Where each entry starts, from the top of the first: `offsets[i]` for
 * entry i, and `offsets[n]` one gap past the end of the last.
 */
export function entryOffsets(heights: readonly number[], gap: number): Float64Array {
  const offsets = new Float64Array(heights.length + 1)
  for (let i = 0; i < heights.length; i += 1) offsets[i + 1] = offsets[i]! + heights[i]! + gap
  return offsets
}

/**
 * The height of a spacer standing for entries [from, to): their heights and
 * the gaps between them; the gap after the spacer is the list's own.
 */
export function spacerHeight(offsets: Float64Array, from: number, to: number, gap: number): number {
  return Math.max(0, offsets[to]! - offsets[from]! - gap)
}

function firstWhere(lo: number, hi: number, test: (i: number) => boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (test(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * The entries to render, as sorted runs [start, end): those that reach into
 * the visible part (`visible`, from the top of the first entry; none when
 * null) widened by `overscan` on each side, and each entry in `kept`.
 */
export function windowRuns(
  offsets: Float64Array,
  gap: number,
  visible: { top: number; height: number } | null,
  overscan: number,
  kept: Iterable<number>,
): [number, number][] {
  const count = offsets.length - 1
  const runs: [number, number][] = []
  if (visible) {
    const lo = visible.top - overscan
    const hi = visible.top + visible.height + overscan
    const start = firstWhere(0, count, (i) => offsets[i + 1]! - gap > lo)
    const end = firstWhere(start, count, (i) => offsets[i]! >= hi)
    if (start < end) runs.push([start, end])
  }
  for (const i of kept) if (i >= 0 && i < count) runs.push([i, i + 1])
  runs.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const run of runs) {
    const last = merged.at(-1)
    if (last && run[0] <= last[1]) last[1] = Math.max(last[1], run[1])
    else merged.push([run[0], run[1]])
  }
  return merged
}
