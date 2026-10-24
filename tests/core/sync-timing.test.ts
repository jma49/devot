// When the engine pushes: 3 s after the last write, and at least every 10 s while writes go on
// (docs/adr/0002-sync-latest-state-per-record.md, Push timing). The relay is a stub that takes
// every push; the clock is Vitest's.
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClock, createIdGenerator, createNoteService, observeWrites } from '../../src/core'
import { createSyncEngine, PUSH_EVERY_MS, PUSH_IDLE_MS } from '../../src/core/sync/engine'
import type { SyncTransport } from '../../src/core/sync/transport'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

let storage: SqliteAdapter
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  storage = openSqliteAdapter(join(tempDir('devot-sync-timing-'), 'db.sqlite'))
})
afterEach(() => {
  vi.useRealTimers()
  storage.close()
})

function stubRelay() {
  const pushed: number[] = []
  let version = 0
  const transport: SyncTransport = {
    connect: async () => ({ time: Date.now(), epoch: 'e1', seq: 0, device: 'd' }),
    pull: async (since) => ({ records: [], next: since, more: false }),
    push: async () => {
      pushed.push(Date.now())
      return { type: 'pushed', version: (version += 1), seq: version }
    },
    close: async () => {},
  }
  return { transport, pushed }
}

it('pushes 3 s after typing stops, and every 10 s while it goes on', async () => {
  const clock = createClock('mac')
  const newId = createIdGenerator()
  const { transport, pushed } = stubRelay()
  const engine = createSyncEngine({
    storage,
    sync: storage,
    transport,
    clock,
    newId,
    random: () => 0.5,
  })
  const notes = createNoteService({
    storage: observeWrites(storage, () => engine.touch()),
    clock,
    newId,
    saveDelayMs: 300,
  })
  engine.start()
  await engine.idle()
  const id = await notes.create('Typing')
  await notes.flush()
  pushed.length = 0
  const start = Date.now()

  // A key every 500 ms for 25 s: a push at 10 s and 20 s, then 3 s after the last key.
  for (let at = 0; at < 25_000; at += 500) {
    await notes.setBody(id, `word ${at}\n`)
    await vi.advanceTimersByTimeAsync(500)
  }
  await vi.advanceTimersByTimeAsync(PUSH_IDLE_MS + 1_000)
  await engine.idle()
  const offsets = pushed.map((t) => t - start)
  expect(offsets).toHaveLength(3)
  expect(offsets[0]).toBeGreaterThanOrEqual(PUSH_EVERY_MS)
  expect(offsets[0]).toBeLessThan(PUSH_EVERY_MS + 1_000)
  expect(offsets[1]! - offsets[0]!).toBeGreaterThanOrEqual(PUSH_EVERY_MS)
  expect(offsets[2]).toBeGreaterThanOrEqual(25_000 + PUSH_IDLE_MS - 500)
  await engine.stop()
})
