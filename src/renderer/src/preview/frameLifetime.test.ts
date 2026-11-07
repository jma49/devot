import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { frameLifetime } from './frameLifetime'

describe('the lifetime of the diagram frame', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('closes the frame a while after the last drawing shown goes', () => {
    const close = vi.fn<() => void>()
    const hold = frameLifetime(1000, close)
    const answered = hold()
    const first = hold()
    const second = hold()
    answered()
    first()
    vi.advanceTimersByTime(5000)
    expect(close).not.toHaveBeenCalled()
    second()
    vi.advanceTimersByTime(999)
    expect(close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps the frame while a request waits for it', () => {
    const close = vi.fn<() => void>()
    const hold = frameLifetime(1000, close)
    const answered = hold()
    vi.advanceTimersByTime(5000)
    expect(close).not.toHaveBeenCalled()
    answered()
    vi.advanceTimersByTime(1000)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps the frame when another note asks for a drawing before the wait is over', () => {
    const close = vi.fn<() => void>()
    const hold = frameLifetime(1000, close)
    hold()()
    vi.advanceTimersByTime(500)
    const answered = hold()
    vi.advanceTimersByTime(5000)
    expect(close).not.toHaveBeenCalled()
    answered()
    vi.advanceTimersByTime(1000)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('counts a drawing or a request once, however often it ends', () => {
    const close = vi.fn<() => void>()
    const hold = frameLifetime(1000, close)
    const gone = hold()
    hold()
    gone()
    gone()
    vi.advanceTimersByTime(5000)
    expect(close).not.toHaveBeenCalled()
  })
})
