import { describe, expect, it } from 'vitest'
import { entryOffsets, spacerHeight, windowRuns } from './listWindow'

describe('entryOffsets', () => {
  it('puts each entry after the ones before it and their gaps', () => {
    expect([...entryOffsets([10, 20, 30], 2)]).toEqual([0, 12, 34, 66])
    expect([...entryOffsets([], 2)]).toEqual([0])
  })
})

describe('spacerHeight', () => {
  it('stands for the entries it replaces, less the gap that follows it', () => {
    const offsets = entryOffsets([10, 20, 30], 2)
    expect(spacerHeight(offsets, 0, 2, 2)).toBe(32)
    expect(spacerHeight(offsets, 2, 3, 2)).toBe(30)
  })
})

describe('windowRuns', () => {
  // 100 entries of 10 px with no gap: entry i spans [10 i, 10 i + 10).
  const offsets = entryOffsets(
    Array.from({ length: 100 }, () => 10),
    0,
  )

  it('renders the entries that show, and those within the overscan', () => {
    expect(windowRuns(offsets, 0, { top: 200, height: 50 }, 0, [])).toEqual([[20, 25]])
    expect(windowRuns(offsets, 0, { top: 200, height: 50 }, 30, [])).toEqual([[17, 28]])
    expect(windowRuns(offsets, 0, { top: 0, height: 50 }, 30, [])).toEqual([[0, 8]])
    expect(windowRuns(offsets, 0, { top: 980, height: 50 }, 30, [])).toEqual([[95, 100]])
  })

  it('keeps the entries asked for, each in a run of its own unless it touches another', () => {
    expect(windowRuns(offsets, 0, { top: 200, height: 50 }, 0, [3, 25, 90, 91])).toEqual([
      [3, 4],
      [20, 26],
      [90, 92],
    ])
  })

  it('renders only the kept entries when nothing shows yet', () => {
    expect(windowRuns(offsets, 0, null, 30, [5, 6, 50])).toEqual([
      [5, 7],
      [50, 51],
    ])
  })

  it('ignores kept entries outside the list', () => {
    expect(windowRuns(offsets, 0, { top: 200, height: 50 }, 0, [-1, 100])).toEqual([[20, 25]])
  })

  it('renders nothing but the kept entries for an empty viewport past the end', () => {
    expect(windowRuns(offsets, 0, { top: 5000, height: 50 }, 0, [0])).toEqual([[0, 1]])
    expect(windowRuns(entryOffsets([], 0), 0, { top: 0, height: 50 }, 0, [])).toEqual([])
  })

  it('counts the gap between entries', () => {
    const gapped = entryOffsets(
      Array.from({ length: 10 }, () => 10),
      5,
    )
    // [32, 44) touches entry 2 ([30, 40)) only.
    expect(windowRuns(gapped, 5, { top: 32, height: 12 }, 0, [])).toEqual([[2, 3]])
    // [41, 46) falls in the gap after entry 2 and before entry 3 ([45, 55)).
    expect(windowRuns(gapped, 5, { top: 41, height: 5 }, 0, [])).toEqual([[3, 4]])
  })
})
