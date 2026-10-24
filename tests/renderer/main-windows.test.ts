import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { coalesced, listsLink, reportingWrites } from '../../src/renderer/src/mainWindows'
import { fromWire, toWire } from '../../src/renderer/src/storage/wire'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function storage(): SqliteAdapter {
  const adapter = openSqliteAdapter(join(tempDir('devot-mains-'), 'devot.sqlite'))
  open.push(adapter)
  return adapter
}

describe('coalesced', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs once, a while after the first call of a burst', () => {
    const run = vi.fn<() => void>()
    const call = coalesced(run, 250)
    call()
    vi.advanceTimersByTime(100)
    call()
    call()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(150)
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('runs again for the next burst', () => {
    const run = vi.fn<() => void>()
    const call = coalesced(run, 250)
    call()
    vi.advanceTimersByTime(250)
    call()
    vi.advanceTimersByTime(250)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('reportingWrites', () => {
  it('reports what the lists show: notes, notebooks, tags and their links, once written', async () => {
    const wrote = vi.fn<() => void>()
    const adapter = storage()
    const clock = createClock('mac1')
    const newId = createIdGenerator()
    const notes = createNoteService({
      storage: fromWire(reportingWrites(toWire(adapter), wrote)),
      clock,
      newId,
      saveDelayMs: 5,
    })
    expect(wrote).not.toHaveBeenCalled()
    const id = await notes.create('A')
    await notes.flush()
    expect(wrote).toHaveBeenCalled()
    const afterCreate = wrote.mock.calls.length
    await notes.list()
    await notes.read(id)
    expect(wrote).toHaveBeenCalledTimes(afterCreate)
    await notes.setStatus(id, 'active')
    await notes.flush()
    expect(wrote.mock.calls.length).toBeGreaterThan(afterCreate)
  })

  it('does not report a write that failed', async () => {
    const wrote = vi.fn<() => void>()
    const adapter = storage()
    const wire = toWire(adapter)
    const failing = reportingWrites(
      {
        ...wire,
        putBook: () => Promise.reject(new Error('E_TEST')),
      },
      wrote,
    )
    await expect(
      failing.putBook({ id: 'b', name: 'B' } as unknown as Parameters<typeof wire.putBook>[0]),
    ).rejects.toThrow('E_TEST')
    expect(wrote).not.toHaveBeenCalled()
  })
})

describe('listsLink in the tests’ build', () => {
  beforeEach(() => vi.stubGlobal('DEVOT_UI_TEST', true))
  afterEach(() => vi.unstubAllGlobals())

  it('tells every main window but the sender', async () => {
    const first = listsLink('main')
    const second = listsLink('main-2')
    const heardFirst = vi.fn<() => void>()
    const heardSecond = vi.fn<() => void>()
    const stopFirst = await first.listen(heardFirst)
    const stopSecond = await second.listen(heardSecond)
    first.send()
    await vi.waitFor(() => expect(heardSecond).toHaveBeenCalledTimes(1))
    expect(heardFirst).not.toHaveBeenCalled()
    stopFirst()
    stopSecond()
  })
})
