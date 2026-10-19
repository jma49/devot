import { describe, expect, it, vi } from 'vitest'
import { animationMs, tooltipMotion, whenClosed, type ClosingTarget } from './closing'

function fakeTarget() {
  const listeners = new Map<string, Set<(e: { target: unknown }) => void>>()
  const target: ClosingTarget & {
    fire: (type: string, from?: unknown) => void
    count: () => number
  } = {
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set()
      set.add(fn)
      listeners.set(type, set)
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    fire: (type, from = target) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ target: from })
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
  return target
}

describe('animationMs', () => {
  it('reads seconds and milliseconds, adding the delay', () => {
    expect(animationMs('0.3s')).toBe(300)
    expect(animationMs('400ms', '0.1s')).toBe(500)
  })

  it('takes the longest of a list, pairing durations with delays', () => {
    expect(animationMs('0.3s, 0.4s', '0s, 0.2s')).toBe(600)
    // Delays repeat when the list is shorter, as in CSS.
    expect(animationMs('0.3s, 0.4s', '0.1s')).toBe(500)
  })

  it('is 0 for no animation or nonsense', () => {
    expect(animationMs('0s')).toBe(0)
    expect(animationMs('')).toBe(0)
    expect(animationMs('auto')).toBe(0)
  })
})

describe('whenClosed', () => {
  it('finishes when the element’s own animation ends, once, and stops listening', () => {
    vi.useFakeTimers()
    const target = fakeTarget()
    const done = vi.fn<() => void>()
    whenClosed(target, done, 300)
    target.fire('animationend')
    target.fire('animationend')
    vi.advanceTimersByTime(1000)
    expect(done).toHaveBeenCalledTimes(1)
    expect(target.count()).toBe(0)
    vi.useRealTimers()
  })

  it('ignores an animation ending inside the element', () => {
    vi.useFakeTimers()
    const target = fakeTarget()
    const done = vi.fn<() => void>()
    whenClosed(target, done, 300)
    target.fire('animationend', { child: true })
    expect(done).not.toHaveBeenCalled()
    target.fire('animationcancel')
    expect(done).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('finishes after the fallback when no end event comes', () => {
    vi.useFakeTimers()
    const target = fakeTarget()
    const done = vi.fn<() => void>()
    whenClosed(target, done, 300)
    vi.advanceTimersByTime(299)
    expect(done).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(done).toHaveBeenCalledTimes(1)
    expect(target.count()).toBe(0)
    vi.useRealTimers()
  })

  it('does nothing once cancelled', () => {
    vi.useFakeTimers()
    const target = fakeTarget()
    const done = vi.fn<() => void>()
    const cancel = whenClosed(target, done, 300)
    cancel()
    target.fire('animationend')
    vi.advanceTimersByTime(1000)
    expect(done).not.toHaveBeenCalled()
    expect(target.count()).toBe(0)
    vi.useRealTimers()
  })
})

describe('tooltipMotion', () => {
  it('fades the completion lists out, and the floating bars not at all', () => {
    expect(tooltipMotion(['cm-tooltip', 'cm-float-bar', 'cm-format-toolbar'])).toBeNull()
    expect(tooltipMotion(['cm-tooltip', 'cm-tooltip-autocomplete', 'cm-popup-slash'])).toBe('fade')
  })

  it('leaves other tooltips alone', () => {
    expect(tooltipMotion(['cm-tooltip', 'cm-tooltip-hover'])).toBeNull()
    expect(tooltipMotion(['cm-float-bar'])).toBeNull()
  })
})
