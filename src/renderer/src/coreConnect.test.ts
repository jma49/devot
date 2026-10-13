import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveProblem } from '../../core'
import { connectCore, type CoreWorker } from './coreConnect'
import type { LogEntry } from './log'

class FakeWorker extends EventTarget implements CoreWorker {
  terminated = false
  postMessage() {}
  terminate() {
    this.terminated = true
  }
  send(type: string, extra: object = {}) {
    this.dispatchEvent(Object.assign(new Event(type), extra))
  }
}

const NOTE_ID = '01920000-0000-7000-8000-000000000001'

function handlers() {
  return {
    onSaveProblems: vi.fn<(problems: SaveProblem[]) => void>(),
    onLog: vi.fn<(entry: LogEntry) => void>(),
    onFailure: vi.fn<(code: string) => void>(),
  }
}

/** Connects with a `start` that the test settles by hand. */
function connect(worker: FakeWorker, start: () => Promise<unknown>, timeoutMs = 1000) {
  const h = handlers()
  const core = connectCore(worker, {
    wrap: () => ({}) as never,
    start,
    timeoutMs,
    ...h,
  })
  return { core, ...h }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('connectCore', () => {
  it('gives the core once it has started', async () => {
    const worker = new FakeWorker()
    const { core } = connect(worker, async () => undefined)
    await expect(core).resolves.toBeDefined()
    expect(worker.terminated).toBe(false)
  })

  it('rejects with a code when the worker fails before it is ready, and stops it', async () => {
    const worker = new FakeWorker()
    const { core } = connect(worker, () => new Promise(() => {}))
    worker.send('error', { message: 'Diary' })
    await expect(core).rejects.toThrow('E_CORE_WORKER_FAILED')
    expect(worker.terminated).toBe(true)
  })

  it('rejects when the core does not start in time', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const { core } = connect(worker, () => new Promise(() => {}), 5000)
    const outcome = core.then(
      () => 'started',
      (e: Error) => e.message,
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(await outcome).toBe('E_CORE_START_TIMEOUT')
    expect(worker.terminated).toBe(true)
  })

  it('rejects with the code of a failed start, and stops the worker', async () => {
    const worker = new FakeWorker()
    const { core } = connect(worker, () => Promise.reject(new Error('E_STORAGE_BUSY at /Users/a')))
    await expect(core).rejects.toThrow('E_STORAGE_BUSY')
    expect(worker.terminated).toBe(true)
  })

  it('reports a failure of the running worker by code, and keeps it', async () => {
    const worker = new FakeWorker()
    const { core, onFailure } = connect(worker, async () => undefined)
    await core
    worker.send('error')
    worker.send('messageerror')
    expect(onFailure.mock.calls).toEqual([['E_CORE_WORKER_FAILED'], ['E_CORE_WORKER_FAILED']])
    expect(worker.terminated).toBe(false)
  })

  it('hands on the logs and save problems the worker posts', async () => {
    const worker = new FakeWorker()
    const { core, onLog, onSaveProblems } = connect(worker, async () => undefined)
    await core
    const entry = { level: 'warn', code: 'W_REVISION_FAILED', ids: [NOTE_ID] }
    worker.send('message', { data: { workerLog: entry } })
    worker.send('message', { data: { saveProblems: [{ id: NOTE_ID, code: 'E_STORAGE_FULL' }] } })
    worker.send('message', { data: 'something else' })
    expect(onLog.mock.calls).toEqual([[entry]])
    expect(onSaveProblems.mock.calls).toEqual([[[{ id: NOTE_ID, code: 'E_STORAGE_FULL' }]]])
  })
})
