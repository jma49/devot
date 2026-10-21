import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  animationMs,
  enterFrom,
  timeReaching,
  tooltipMotion,
  whenClosed,
  type ClosingTarget,
} from './closing'

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

describe('timeReaching', () => {
  const easeOut = (ms: number) => 1 - (1 - Math.min(ms, 200) / 200) ** 2

  it('picks up an entrance where the closing copy had faded to, never short of it', () => {
    const t = timeReaching(0.75, easeOut, 200)
    expect(t).toBeCloseTo(100, -1)
    expect(easeOut(t)).toBeGreaterThanOrEqual(0.75)
    expect(easeOut(t - 1)).toBeLessThan(0.75)
  })

  it('starts from the beginning when the copy had faded out, and at the end when it had not begun', () => {
    expect(timeReaching(0, easeOut, 200)).toBe(0)
    expect(timeReaching(1, easeOut, 200)).toBe(200)
  })

  it('stays put when there is nothing to run', () => {
    expect(timeReaching(0.5, easeOut, 0)).toBe(0)
  })
})

// A 200 ms CSS entrance on a clock the test moves: its opacity follows the
// inline `animation-delay` as a browser's would, and `restart` starts it
// again the way WebKit can a frame after a modal dialog opens.
describe('enterFrom', () => {
  const ENTRANCE_MS = 200
  const clock = { now: 0 }
  const grow = (ms: number) => 1 - (1 - Math.min(Math.max(ms, 0), ENTRANCE_MS) / ENTRANCE_MS) ** 2

  function entrance() {
    type Listener = (e: { target: unknown; pseudoElement: string }) => void
    const listeners = new Set<Listener>()
    const el = {
      startedAt: clock.now,
      style: {
        animationDelay: '',
        removeProperty(name: string) {
          if (name === 'animation-delay') this.animationDelay = ''
        },
      },
      addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
      opacity: () =>
        grow(clock.now - el.startedAt - Number.parseFloat(el.style.animationDelay || '0')),
      restart: () => {
        el.startedAt = clock.now
        for (const fn of [...listeners]) fn({ target: el, pseudoElement: '' })
      },
      computed: () => ({
        opacity: String(el.opacity()),
        animationDuration: `${ENTRANCE_MS}ms`,
        animationDelay: el.style.animationDelay || '0s',
        animationName: 'enter',
      }),
    }
    return el
  }

  const fadingCopy = (opacity: number) => ({
    remove: vi.fn<() => void>(),
    computed: () => ({ opacity: String(opacity) }),
  })

  function takeOver(copyOpacity: number) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    vi.stubGlobal('getComputedStyle', (node: { computed: () => object }) => node.computed())
    clock.now = 5000
    const el = entrance()
    const copy = fadingCopy(copyOpacity)
    enterFrom(el as unknown as HTMLElement, copy as unknown as Element)
    expect(copy.remove).toHaveBeenCalledOnce()
    return el
  }

  function shownOver(el: ReturnType<typeof entrance>, steps: number[]) {
    const shown = [el.opacity()]
    for (const step of steps) {
      clock.now += step
      shown.push(el.opacity())
    }
    return shown
  }

  const expectNeverFalls = (shown: number[]) =>
    shown.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(shown[i - 1] ?? 0))

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a pop-up opened again starts where its fading copy was and only grows to full', () => {
    const el = takeOver(0.6)
    const shown = shownOver(el, Array<number>(15).fill(16))
    expect(shown[0]).toBeGreaterThanOrEqual(0.6)
    expect(shown[0]).toBeLessThan(0.61)
    expectNeverFalls(shown)
    expect(shown.at(-1)).toBe(1)
  })

  it('never dips however unevenly the frames come', () => {
    const el = takeOver(0.3)
    const shown = shownOver(el, [3, 150, 1, 30, 100])
    expect(shown[0]).toBeGreaterThanOrEqual(0.3)
    expectNeverFalls(shown)
    expect(shown.at(-1)).toBe(1)
  })

  it('an entrance started again a frame later resumes where it had got to', () => {
    const el = takeOver(0.5)
    const before = shownOver(el, [16])
    el.restart()
    const after = shownOver(el, [0, 16, 16])
    expectNeverFalls([...before, ...after])
    expect(after[0]).toBeCloseTo(before.at(-1)!, 5)
  })

  it('a copy that had faded out lets the entrance start from the beginning', () => {
    const el = takeOver(0)
    expect(el.style.animationDelay).toBe('')
    expect(el.opacity()).toBe(0)
  })
})
