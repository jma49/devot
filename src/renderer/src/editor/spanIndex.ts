// Which span of a format a position is in, answered in logarithmic time.
// Formats ask about every character of a region: scanning the spans for each
// one makes a long line with many spans quadratic.

/** A formatted span: `from`–`openTo` and `closeFrom`–`to` are its markers. */
export interface IndexedSpan {
  from: number
  to: number
  openTo: number
  closeFrom: number
}

/** Whether `pos` is in the span's markers. */
export const isMarker = (span: IndexedSpan, pos: number) =>
  (span.from <= pos && pos < span.openTo) || (span.closeFrom <= pos && pos < span.to)

/** Whether `pos` is in the span's text, between its markers. */
export const isInside = (span: IndexedSpan, pos: number) =>
  span.openTo <= pos && pos < span.closeFrom

/**
 * Looks spans up by position. Spans of one format are outermost ones, so
 * they do not overlap; a set that does (a caller's mistake) is searched in
 * full instead, which is slower and gives the same answers.
 */
export class SpanIndex {
  private readonly sorted: readonly IndexedSpan[]
  private readonly disjoint: boolean

  constructor(spans: readonly IndexedSpan[]) {
    this.sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to)
    this.disjoint = this.sorted.every((s, i) => i === 0 || (this.sorted[i - 1]?.to ?? 0) <= s.from)
  }

  /** The span with `pos` in its markers or its text, if any. */
  at(pos: number): IndexedSpan | undefined {
    if (!this.disjoint) return this.sorted.find((s) => s.from <= pos && pos < s.to)
    // The last span starting at or before `pos`.
    let low = 0
    let high = this.sorted.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((this.sorted[mid]?.from ?? Infinity) <= pos) low = mid + 1
      else high = mid
    }
    const span = this.sorted[low - 1]
    return span && pos < span.to ? span : undefined
  }

  /** Whether `pos` is in one of the spans' markers. */
  marker(pos: number): boolean {
    if (!this.disjoint) return this.sorted.some((s) => isMarker(s, pos))
    const span = this.at(pos)
    return !!span && isMarker(span, pos)
  }

  /** Whether `pos` is in one of the spans' text. */
  inside(pos: number): boolean {
    if (!this.disjoint) return this.sorted.some((s) => isInside(s, pos))
    const span = this.at(pos)
    return !!span && isInside(span, pos)
  }
}

/**
 * The positions covered by any of a set of ranges, which may overlap or
 * come in any order.
 */
export class Covered {
  private readonly merged: { from: number; to: number }[] = []

  constructor(ranges: readonly { from: number; to: number }[]) {
    const sorted = [...ranges].sort((a, b) => a.from - b.from)
    for (const r of sorted) {
      const last = this.merged.at(-1)
      if (last && r.from <= last.to) last.to = Math.max(last.to, r.to)
      else this.merged.push({ from: r.from, to: r.to })
    }
  }

  has(pos: number): boolean {
    let low = 0
    let high = this.merged.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((this.merged[mid]?.from ?? Infinity) <= pos) low = mid + 1
      else high = mid
    }
    const range = this.merged[low - 1]
    return !!range && pos < range.to
  }
}
