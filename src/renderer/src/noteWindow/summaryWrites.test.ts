import { describe, expect, it } from 'vitest'
import { summaryAfterWrites } from './summaryWrites'

const summary = { id: 'a', updatedAt: 5, title: 'A' }

describe("the note window's summary after a write", () => {
  it("takes this note's new updated time from the writes the core reports", () => {
    expect(summaryAfterWrites(summary, new Map([['a', 9]]))).toEqual({ ...summary, updatedAt: 9 })
  })

  it('keeps the same summary for other notes, older times and no summary yet', () => {
    expect(summaryAfterWrites(summary, new Map([['b', 9]]))).toBe(summary)
    expect(summaryAfterWrites(summary, new Map([['a', 4]]))).toBe(summary)
    expect(summaryAfterWrites(undefined, new Map([['a', 9]]))).toBeUndefined()
  })
})
