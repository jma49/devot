import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRAG_SAVE_MS, throttledStore } from './draggedNumber'

describe('throttledStore', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('stores the first value at once, then at most once per interval, the newest', () => {
    const stored: number[] = []
    const saver = throttledStore(
      (v) => stored.push(v),
      () => Date.now(),
    )
    saver.push(10)
    expect(stored).toEqual([10])
    saver.push(15)
    saver.push(20)
    expect(stored).toEqual([10])
    vi.advanceTimersByTime(DRAG_SAVE_MS)
    expect(stored).toEqual([10, 20])
  })

  it('stores the value still waiting when the drag stops, and nothing after', () => {
    const stored: number[] = []
    const saver = throttledStore(
      (v) => stored.push(v),
      () => Date.now(),
    )
    saver.push(10)
    saver.push(30)
    saver.flush()
    expect(stored).toEqual([10, 30])
    vi.advanceTimersByTime(DRAG_SAVE_MS * 2)
    saver.flush()
    expect(stored).toEqual([10, 30])
  })

  it('drops a waiting value once cancelled', () => {
    const stored: number[] = []
    const saver = throttledStore(
      (v) => stored.push(v),
      () => Date.now(),
    )
    saver.push(10)
    saver.push(40)
    saver.cancel()
    vi.advanceTimersByTime(DRAG_SAVE_MS * 2)
    expect(stored).toEqual([10])
  })
})
