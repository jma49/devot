import { describe, expect, it } from 'vitest'
import { Covered, SpanIndex, isInside, isMarker, type IndexedSpan } from './spanIndex'

const span = (from: number, to: number, mark = 2): IndexedSpan => ({
  from,
  to,
  openTo: from + mark,
  closeFrom: to - mark,
})

function naive(spans: IndexedSpan[], pos: number): [boolean, boolean] {
  return [spans.some((s) => isMarker(s, pos)), spans.some((s) => isInside(s, pos))]
}

function differences(spans: IndexedSpan[], end: number): number[] {
  const index = new SpanIndex(spans)
  const wrong: number[] = []
  for (let pos = -1; pos <= end + 1; pos++) {
    const [marker, inside] = naive(spans, pos)
    if (index.marker(pos) !== marker || index.inside(pos) !== inside) wrong.push(pos)
  }
  return wrong
}

describe('span index', () => {
  it('answers like a scan over disjoint spans, given in any order', () => {
    const spans = [span(20, 30), span(0, 6), span(10, 14), span(30, 40, 1), span(7, 9, 1)]
    expect(differences(spans, 45)).toEqual([])
  })

  it('knows empty pairs and the gaps between spans', () => {
    const empty: IndexedSpan = { from: 4, to: 8, openTo: 6, closeFrom: 6 }
    expect(differences([span(0, 3, 1), empty, span(8, 12)], 14)).toEqual([])
    expect(new SpanIndex([]).marker(3)).toBe(false)
  })

  it('answers like a scan when spans overlap', () => {
    expect(differences([span(0, 20), span(5, 10), span(8, 30)], 35)).toEqual([])
  })

  it('finds the span a position is in', () => {
    const a = span(0, 6)
    const b = span(10, 16)
    const index = new SpanIndex([b, a])
    expect(index.at(0)).toBe(a)
    expect(index.at(5)).toBe(a)
    expect(index.at(6)).toBeUndefined()
    expect(index.at(12)).toBe(b)
    expect(index.at(16)).toBeUndefined()
  })
})

describe('covered positions', () => {
  it('answers like a scan, for ranges that overlap, touch or come in any order', () => {
    const ranges = [
      { from: 20, to: 25 },
      { from: 0, to: 4 },
      { from: 3, to: 8 },
      { from: 8, to: 9 },
      { from: 12, to: 12 },
      { from: 30, to: 31 },
    ]
    const covered = new Covered(ranges)
    for (let pos = -1; pos <= 33; pos++)
      expect(covered.has(pos), `at ${pos}`).toBe(ranges.some((r) => r.from <= pos && pos < r.to))
    expect(new Covered([]).has(0)).toBe(false)
  })
})
