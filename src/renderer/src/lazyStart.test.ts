import { describe, expect, it, vi } from 'vitest'
import { lazyEngine, lazyOnce, trackedRuns } from './lazyStart'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function engine(name: string) {
  return {
    name,
    start: vi.fn<() => void>(),
    stop: vi.fn<() => Promise<void>>(async () => {}),
  }
}

type Engine = ReturnType<typeof engine>
const lazy = (load: () => Promise<typeof engine>) => lazyEngine<typeof engine, Engine>(load)

describe('lazyEngine', () => {
  it('starts the engine once its code loads, and stops it', async () => {
    const slot = lazy(async () => engine)
    await slot.start((make) => make('a'))
    const started = slot.current!
    expect(started.start).toHaveBeenCalledTimes(1)
    await slot.stop()
    expect(started.stop).toHaveBeenCalledTimes(1)
    expect(slot.current).toBeUndefined()
  })

  it('makes nothing when a stop comes while the code loads', async () => {
    const load = deferred<typeof engine>()
    const slot = lazy(() => load.promise)
    const make = vi.fn<(m: typeof engine) => Engine>((m) => m('a'))
    const starting = slot.start(make)
    await slot.stop()
    load.resolve(engine)
    await starting
    expect(make).not.toHaveBeenCalled()
    expect(slot.current).toBeUndefined()
  })

  it('lets the later of two starts made while the code loads win', async () => {
    const loads = [deferred<typeof engine>(), deferred<typeof engine>()]
    let next = 0
    const slot = lazy(() => loads[next++]!.promise)
    const first = slot.start((m) => m('first'))
    const second = slot.start((m) => m('second'))
    loads[0]!.resolve(engine)
    await first
    expect(slot.current).toBeUndefined()
    loads[1]!.resolve(engine)
    await second
    expect(slot.current?.name).toBe('second')
    expect(slot.current?.start).toHaveBeenCalledTimes(1)
  })

  it('starts again after a stop made while an earlier start loaded', async () => {
    const load = deferred<typeof engine>()
    const slot = lazy(() => load.promise)
    const stale = slot.start((m) => m('stale'))
    await slot.stop()
    const fresh = slot.start((m) => m('fresh'))
    load.resolve(engine)
    await Promise.all([stale, fresh])
    expect(slot.current?.name).toBe('fresh')
  })

  it('passes a failed load to the caller and stays stopped', async () => {
    const slot = lazy(() => Promise.reject(new Error('E_LOAD')))
    await expect(slot.start((m) => m('a'))).rejects.toThrow('E_LOAD')
    expect(slot.current).toBeUndefined()
  })
})

describe('lazyOnce', () => {
  it('makes one thing however many starts come while its code loads', async () => {
    const load = deferred<string>()
    const once = lazyOnce<string, { from: string }>(() => load.promise)
    const make = vi.fn<(loaded: string) => { from: string }>((loaded) => ({ from: loaded }))
    const starts = [once.start(make), once.start(make)]
    expect(once.current).toBeUndefined()
    load.resolve('mirror')
    await Promise.all(starts)
    expect(make).toHaveBeenCalledTimes(1)
    expect(once.current).toEqual({ from: 'mirror' })
    await once.start(make)
    expect(make).toHaveBeenCalledTimes(1)
  })

  it('tries again after a failed load', async () => {
    let fail = true
    const once = lazyOnce<string, string>(async () => {
      if (fail) throw new Error('E_LOAD')
      return 'mirror'
    })
    await expect(once.start((loaded) => loaded)).rejects.toThrow('E_LOAD')
    fail = false
    await once.start((loaded) => loaded)
    expect(once.current).toBe('mirror')
  })
})

describe('trackedRuns', () => {
  it('passes a failed run to its caller, and waiting for it settles', async () => {
    const runs = trackedRuns()
    const run = runs.run(() => Promise.reject(new Error('E_LOAD')))
    await expect(run).rejects.toThrow('E_LOAD')
    await expect(runs.settled()).resolves.toBeUndefined()
  })

  it('waits for the last run to end', async () => {
    const runs = trackedRuns()
    const task = deferred<number>()
    const run = runs.run(() => task.promise)
    let settled = false
    const waiting = runs.settled().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    task.resolve(1)
    await expect(run).resolves.toBe(1)
    await waiting
    expect(settled).toBe(true)
  })
})
