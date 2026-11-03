import { describe, expect, it } from 'vitest'
import { fractionAtLine, lineAtFraction } from './scrollPane'

describe('lines inside a block of several lines', () => {
  it('share out the block evenly, so a rendered block still maps line by line', () => {
    expect(lineAtFraction(10, 14, 0)).toBe(10)
    expect(lineAtFraction(10, 14, 0.5)).toBe(12.5)
    expect(lineAtFraction(10, 14, 1)).toBe(15)
    expect(fractionAtLine(10, 14, 12.5)).toBe(0.5)
    expect(fractionAtLine(10, 14, 15)).toBe(1)
  })

  it('are a line and its fraction for a block of one line', () => {
    expect(lineAtFraction(7, 7, 0.25)).toBe(7.25)
    expect(fractionAtLine(7, 7, 7.25)).toBe(0.25)
  })

  it('stay inside the block', () => {
    expect(lineAtFraction(3, 4, 2)).toBe(5)
    expect(fractionAtLine(3, 4, 1)).toBe(0)
  })

  it('round-trip', () => {
    for (const into of [0, 0.1, 0.33, 0.9]) {
      expect(fractionAtLine(20, 29, lineAtFraction(20, 29, into))).toBeCloseTo(into)
    }
  })
})
