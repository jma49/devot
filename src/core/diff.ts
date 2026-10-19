// Line diffs for showing how two versions of a note differ (Myers' O(ND) algorithm). Display only: edits to a note are applied with `textDiff`.

export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
}

export interface SkippedLines {
  kind: 'skipped'
  count: number
}

export type DiffBlock = DiffLine | SkippedLines

/** Past this many differing lines the comparison shows the changed middle as removed, then added; it bounds the time and the memory (which grows with its square). */
const MAX_EDITS = 2000
/** Long texts get a smaller limit, so a comparison never holds up the worker for long. */
const MAX_WORK = 10_000_000

const lines = (text: string) => (text === '' ? [] : text.split('\n'))

/** The lines kept are a longest common subsequence unless the texts differ in more than MAX_EDITS lines. */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = lines(from)
  const b = lines(to)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const same = (text: string): DiffLine => ({ kind: 'same', text })
  const middle = myers(a.slice(start, endA), b.slice(start, endB)) ?? [
    ...a.slice(start, endA).map((text): DiffLine => ({ kind: 'removed', text })),
    ...b.slice(start, endB).map((text): DiffLine => ({ kind: 'added', text })),
  ]
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(endA).map(same)]
}

function myers(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDITS, Math.max(100, Math.floor(MAX_WORK / (n + m))))
  const offset = max + 1
  // v[offset + k]: the furthest x reached on diagonal k (k = x - y).
  const v = new Int32Array(2 * max + 3)
  // trace[d]: the part of v (diagonals -d - 1 to d + 1) before step d.
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace)
    }
  }
  return null
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): DiffLine[] {
  const out: DiffLine[] = []
  let x = a.length
  let y = b.length
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const at = (k: number) => trace[d]![k + d + 1]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ kind: 'same', text: a[x - 1]! })
      x -= 1
      y -= 1
    }
    if (d === 0) break
    if (x === prevX) out.push({ kind: 'added', text: b[y - 1]! })
    else out.push({ kind: 'removed', text: a[x - 1]! })
    x = prevX
    y = prevY
  }
  return out.reverse()
}

export function foldUnchanged(diff: readonly DiffLine[], context = 3): DiffBlock[] {
  const out: DiffBlock[] = []
  let i = 0
  while (i < diff.length) {
    if (diff[i]!.kind !== 'same') {
      out.push(diff[i]!)
      i += 1
      continue
    }
    let end = i
    while (end < diff.length && diff[end]!.kind === 'same') end += 1
    const keepBefore = i === 0 ? 0 : context
    const keepAfter = end === diff.length ? 0 : context
    if (end - i - keepBefore - keepAfter > 1) {
      out.push(...diff.slice(i, i + keepBefore))
      out.push({ kind: 'skipped', count: end - i - keepBefore - keepAfter })
      out.push(...diff.slice(end - keepAfter, end))
    } else {
      out.push(...diff.slice(i, end))
    }
    i = end
  }
  return out
}
