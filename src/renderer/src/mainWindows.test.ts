import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalesced } from './mainWindows'

afterEach(() => {
  vi.useRealTimers()
})

describe('coalesced', () => {
  it('runs once for a burst, after the delay', () => {
    vi.useFakeTimers()
    const run = vi.fn<() => void>()
    const call = coalesced(run, 250)
    call()
    call()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs a waiting call at once on a flush, and not again when its timer was due', () => {
    vi.useFakeTimers()
    const run = vi.fn<() => void>()
    const call = coalesced(run, 250)
    call()
    call.flush()
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(250)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a flush with nothing waiting', () => {
    const run = vi.fn<() => void>()
    coalesced(run, 250).flush()
    expect(run).not.toHaveBeenCalled()
  })
})
