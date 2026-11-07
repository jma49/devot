// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  frameStats,
  installSpikes,
  percentile,
  pingWatch,
  SPIKES_GLOBAL,
  startWatch,
  type SpikeDeps,
} from './spikes'

afterEach(() => {
  vi.useRealTimers()
})

describe('percentile', () => {
  it('takes the nearest rank, as the Swift harness does', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([4, 1, 3, 2], 50)).toBe(2)
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        95,
      ),
    ).toBe(95)
    expect(percentile([1, 2, 3], 100)).toBe(3)
  })

  it('leaves its input in order', () => {
    const values = [3, 1, 2]
    percentile(values, 50)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('pingWatch', () => {
  it('counts a ping answered within its interval as answered, and the longest silence as the gap', () => {
    const watch = pingWatch(100, 0)
    const a = watch.send(0)
    const b = watch.send(100)
    watch.answer(a, 5)
    watch.answer(b, 140)
    expect(watch.finish(200)).toEqual({ sent: 2, answered: 2, missed: 0, maxGapMs: 135 })
  })

  it('counts a late answer and an unanswered ping as misses, but not a ping still in time', () => {
    const watch = pingWatch(100, 0)
    const late = watch.send(0)
    watch.send(100)
    watch.send(390)
    watch.answer(late, 250)
    expect(watch.finish(400)).toEqual({ sent: 3, answered: 1, missed: 2, maxGapMs: 250 })
  })

  it('takes the time since the last answer at the end as a gap', () => {
    const watch = pingWatch(100, 1000)
    watch.answer(watch.send(1000), 1010)
    expect(watch.finish(1600).maxGapMs).toBe(590)
  })

  it('ignores an answer it did not wait for, or one given twice', () => {
    const watch = pingWatch(100, 0)
    const id = watch.send(0)
    watch.answer(id, 10)
    watch.answer(id, 20)
    watch.answer(99, 30)
    expect(watch.finish(50)).toEqual({ sent: 1, answered: 1, missed: 0, maxGapMs: 40 })
  })
})

describe('frameStats', () => {
  it('reports frame times and the frames past one and a half budgets', () => {
    const deltas = [...Array<number>(97).fill(8.33), 13, 16.7, 25]
    expect(frameStats(deltas, 8.33)).toEqual({
      frames: 100,
      budgetMs: 8.33,
      medianMs: 8.33,
      p95Ms: 8.33,
      maxMs: 25,
      overBudget: 3,
    })
  })

  it('reports nothing measured as zeros', () => {
    expect(frameStats([], 8.33)).toEqual({
      frames: 0,
      budgetMs: 8.33,
      medianMs: 0,
      p95Ms: 0,
      maxMs: 0,
      overBudget: 0,
    })
  })
})

function deps(over: Partial<SpikeDeps> = {}): SpikeDeps {
  return {
    ping: () => Promise.resolve(),
    sync: () => ({ enabled: true, state: 'idle' }),
    touchSync: () => {},
    ...over,
  }
}

describe('startWatch', () => {
  it('pings every interval and reports visibility, viewport and sync in the shape Swift decodes', async () => {
    vi.useFakeTimers()
    let state = 'idle'
    const touchSync = vi.fn<() => void>()
    const ping = vi.fn<() => Promise<unknown>>(() => Promise.resolve())
    const watch = startWatch(deps({ ping, touchSync, sync: () => ({ enabled: true, state }) }), 100)
    expect(touchSync).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(250)
    state = 'syncing'
    await vi.advanceTimersByTimeAsync(250)
    const report = watch.stop()
    expect(ping).toHaveBeenCalledTimes(5)
    expect(Object.keys(report).sort()).toEqual(['hidden', 'pings', 'sync', 'viewport'])
    expect(report.hidden).toBe(0)
    expect(report.pings).toMatchObject({ sent: 5, answered: 5, missed: 0 })
    expect(Object.keys(report.pings).sort()).toEqual(['answered', 'maxGapMs', 'missed', 'sent'])
    expect(report.viewport).toEqual({ resizes: 0, width: innerWidth, height: innerHeight })
    expect(report.sync).toEqual({ enabled: true, states: ['idle', 'syncing'] })
    await vi.advanceTimersByTimeAsync(500)
    expect(ping).toHaveBeenCalledTimes(5)
  })

  it('counts the page turning hidden and the viewport changing size', () => {
    vi.useFakeTimers()
    const watch = startWatch(deps({ sync: () => ({ enabled: false, state: 'off' }) }), 100)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('resize'))
    const width = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(innerWidth + 10)
    window.dispatchEvent(new Event('resize'))
    width.mockRestore()
    visibility.mockRestore()
    const report = watch.stop()
    expect(report.hidden).toBe(1)
    expect(report.viewport.resizes).toBe(1)
    expect(report.sync).toEqual({ enabled: false, states: ['off'] })
  })

  it('does not start a sync that is off', () => {
    const touchSync = vi.fn<() => void>()
    startWatch(deps({ touchSync, sync: () => ({ enabled: false, state: 'off' }) }), 100).stop()
    expect(touchSync).not.toHaveBeenCalled()
  })
})

describe('installSpikes', () => {
  const global = () =>
    (
      window as unknown as Record<
        string,
        { call: (name: string, args: unknown) => Promise<unknown> }
      >
    )[SPIKES_GLOBAL]

  it('answers Swift by name while installed and is gone once removed', async () => {
    let ready = false
    const remove = installSpikes(() => (ready ? deps() : undefined))
    await expect(global()?.call('ready', {})).resolves.toEqual({ ready: false })
    ready = true
    await expect(global()?.call('ready', {})).resolves.toEqual({ ready: true })
    await expect(global()?.call('format', {})).rejects.toThrow('E_SPIKE_UNKNOWN_CALL')
    remove()
    expect(global()).toBeUndefined()
  })

  it('runs the reparenting watch between its start and stop calls', async () => {
    vi.useFakeTimers()
    const remove = installSpikes(() => deps())
    await global()?.call('s1Start', { intervalMs: 100 })
    await vi.advanceTimersByTimeAsync(300)
    const report = (await global()?.call('s1Stop', {})) as {
      pings: { sent: number }
    }
    expect(report.pings.sent).toBe(3)
    await expect(global()?.call('s1Stop', {})).rejects.toThrow('E_SPIKE_NOT_STARTED')
    remove()
  })
})
