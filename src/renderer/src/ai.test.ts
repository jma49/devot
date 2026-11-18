import { describe, expect, it } from 'vitest'
import { newStreamId } from './ai'

describe('stream IDs', () => {
  it('are random in 1 to 2^53 - 1, so a reload or another window never reuses one', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newStreamId()))
    expect(ids.size).toBe(200)
    for (const id of ids) {
      expect(Number.isSafeInteger(id)).toBe(true)
      expect(id).toBeGreaterThan(0)
    }
    expect(newStreamId((words) => words.fill(0xffffffff))).toBe(Number.MAX_SAFE_INTEGER)
    let calls = 0
    // All zero bits would be 0, which Rust refuses: it draws again.
    expect(newStreamId((words) => words.fill(calls++ === 0 ? 0 : 1))).toBe(2 ** 32 + 1)
  })
})
