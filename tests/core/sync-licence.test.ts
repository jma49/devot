// Without a licence Rust refuses to connect (E_LICENCE_REQUIRED): the engine stops and says so
// instead of trying again, until it is started again.
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClock, createIdGenerator } from '../../src/core'
import { createSyncEngine } from '../../src/core/sync/engine'
import type { SyncTransport } from '../../src/core/sync/transport'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

let storage: SqliteAdapter
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  storage = openSqliteAdapter(join(tempDir('devot-sync-licence-'), 'db.sqlite'))
})
afterEach(() => {
  vi.useRealTimers()
  storage.close()
})

it('stops without a licence and never retries on its own', async () => {
  let connects = 0
  const transport: SyncTransport = {
    connect: async () => {
      connects += 1
      throw new Error('E_LICENCE_REQUIRED')
    },
    pull: async (since) => ({ records: [], next: since, more: false }),
    push: async () => ({ type: 'pushed', version: 1, seq: 1 }),
    close: async () => {},
  }
  const engine = createSyncEngine({
    storage,
    sync: storage,
    transport,
    clock: createClock('mac'),
    newId: createIdGenerator(),
    retryBaseMs: 1,
    random: () => 0.5,
  })
  engine.start()
  await engine.idle()
  expect(engine.status()).toMatchObject({ state: 'stopped', code: 'E_LICENCE_REQUIRED' })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  await engine.syncNow()
  await engine.idle()
  expect(connects).toBe(1)
  expect(engine.status().state).toBe('stopped')
  await engine.stop()
})
