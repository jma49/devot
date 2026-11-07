// When the engine pushes: 3 s after the last write, and at least every 10 s while writes go on
// (docs/adr/0002-sync-latest-state-per-record.md, Push timing). The relay is a stub that takes
// every push; the clock is Vitest's.
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  BODY,
  createClock,
  createIdGenerator,
  createNoteService,
  observeWrites,
} from '../../src/core'
import {
  createSyncEngine,
  PUSH_EVERY_MS,
  PUSH_IDLE_MS,
  pushPaceMs,
} from '../../src/core/sync/engine'
import { decodeRecord } from '../../src/core/sync/records'
import { pushOneByOne, type SyncTransport } from '../../src/core/sync/transport'
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
  const records: { id: string; at: number; plaintext: Uint8Array }[] = []
  let version = 0
  const transport: SyncTransport = {
    connect: async () => ({ time: Date.now(), epoch: 'e1', cursor: '', device: 'd' }),
    pull: async (since) => ({ records: [], next: since, more: false }),
    push: async (id, _base, plaintext) => {
      pushed.push(Date.now())
      records.push({ id, at: Date.now(), plaintext })
      return { type: 'pushed', version: (version += 1), seq: version, tag: '' }
    },
    pushMany: (items) => pushOneByOne(transport.push, items),
    close: async () => {},
  }
  return { transport, pushed, records }
}

const bodyOf = (id: string, plaintext: Uint8Array) => {
  const record = decodeRecord(id, plaintext)
  const doc = new Y.Doc()
  if (record.kind === 'note') Y.applyUpdate(doc, record.ydoc)
  return doc.getText(BODY).toString()
}

/** About 1 MB of Markdown: a large note, whose whole state each push carries. */
const largeBody = () => {
  let md = ''
  for (let i = 0; md.length < 1_000_000; i += 1) {
    md += `## Part ${i}\n\nSome **bold** words and a [link](https://example.com/${i}).\n\n- one\n- two\n\n`
  }
  return md
}

async function typingSetup(transport: SyncTransport) {
  const clock = createClock('mac')
  const newId = createIdGenerator()
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
  return { engine, notes }
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

it('waits out a quota pause until the relay’s reset, without trying again before it', async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 23, 22))
  const reset = Date.UTC(2026, 9, 24)
  let connects = 0
  let capped = true
  let version = 0
  const transport: SyncTransport = {
    connect: async () => {
      connects += 1
      return { time: Date.now(), epoch: 'e1', cursor: '', device: 'd', quota: 'on' }
    },
    pull: async (since) => ({ records: [], next: since, more: false }),
    // A relay that does not say until when: the engine takes its next 00:00 UTC.
    push: async () =>
      capped
        ? { type: 'paused', until: null }
        : { type: 'pushed', version: (version += 1), seq: version, tag: '' },
    pushMany: (items) => pushOneByOne(transport.push, items),
    close: async () => {},
  }
  const clock = createClock('mac')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  await notes.create('Waiting')
  await notes.flush()
  const engine = createSyncEngine({
    storage,
    sync: storage,
    transport,
    clock,
    newId,
    random: () => 0.5,
  })
  engine.start()
  await vi.advanceTimersByTimeAsync(0)
  await engine.idle()
  expect(engine.status()).toMatchObject({ state: 'paused', pausedUntil: reset })
  await vi.advanceTimersByTimeAsync(reset - Date.now() - 1_000)
  expect(connects).toBe(1)
  capped = false
  await vi.advanceTimersByTimeAsync(2 * 60_000)
  await engine.idle()
  expect(connects).toBe(2)
  expect(engine.status()).toMatchObject({ state: 'idle', pausedUntil: null })
  await engine.stop()
})

it('rechecks a quota pause at least hourly, so a timer that fell behind during sleep still resumes', async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 23, 18))
  const reset = Date.UTC(2026, 9, 24)
  let connects = 0
  let version = 0
  const transport: SyncTransport = {
    connect: async () => {
      connects += 1
      return { time: Date.now(), epoch: 'e1', cursor: '', device: 'd', quota: 'on' }
    },
    pull: async (since) => ({ records: [], next: since, more: false }),
    push: async () =>
      Date.now() < reset
        ? { type: 'paused', until: reset, limit: 'rowsWritten' }
        : { type: 'pushed', version: (version += 1), seq: version, tag: '' },
    pushMany: (items) => pushOneByOne(transport.push, items),
    close: async () => {},
  }
  const clock = createClock('mac')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  await notes.create('Asleep')
  await notes.flush()
  const engine = createSyncEngine({
    storage,
    sync: storage,
    transport,
    clock,
    newId,
    random: () => 0.5,
  })
  engine.start()
  await vi.advanceTimersByTimeAsync(0)
  await engine.idle()
  expect(engine.status()).toMatchObject({ state: 'paused', pausedUntil: reset })
  // The machine sleeps through the reset: the wall clock moves on, the timers do not.
  vi.setSystemTime(reset + 10 * 60_000)
  await vi.advanceTimersByTimeAsync(62 * 60_000)
  await engine.idle()
  expect(connects).toBe(2)
  expect(engine.status()).toMatchObject({ state: 'idle', pausedUntil: null })
  await engine.stop()
})

it('paces a large note by its size while typing pauses come and go, and sends the last edit', async () => {
  const { transport, records } = stubRelay()
  const { engine, notes } = await typingSetup(transport)
  let body = largeBody()
  const id = await notes.create('Large')
  await notes.setBody(id, body)
  await notes.flush()
  await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS + 1_000)
  await engine.idle()
  expect(records.filter((r) => r.id === id)).toHaveLength(1)

  // A second of typing, then a pause past the idle wait, for a minute: each pause used to push.
  for (let at = 0; at < 60_000; at += 4_500) {
    for (let key = 0; key < 2; key += 1) {
      body = `${body.slice(0, 500)}x${body.slice(500)}`
      await notes.setBody(id, body)
      await vi.advanceTimersByTimeAsync(500)
    }
    await vi.advanceTimersByTimeAsync(3_500)
  }
  await vi.advanceTimersByTimeAsync(60_000)
  await engine.idle()
  const mine = records.filter((r) => r.id === id)
  const paceOf = (pushed: (typeof mine)[number]) => {
    const record = decodeRecord(id, pushed.plaintext)
    return pushPaceMs(record.kind === 'note' ? record.ydoc.length : 0)
  }
  expect(paceOf(mine[0]!)).toBeGreaterThan(PUSH_EVERY_MS / 2)
  for (let at = 1; at < mine.length; at += 1) {
    expect(mine[at]!.at - mine[at - 1]!.at).toBeGreaterThanOrEqual(paceOf(mine[at - 1]!))
  }
  expect(mine.length).toBeLessThanOrEqual(8)
  expect(bodyOf(id, mine.at(-1)!.plaintext)).toBe(body)
  await engine.stop()
})

it('pushes a paced note at once on Sync Now', async () => {
  const { transport, records } = stubRelay()
  const { engine, notes } = await typingSetup(transport)
  let body = largeBody()
  const id = await notes.create('Large')
  await notes.setBody(id, body)
  await notes.flush()
  await vi.advanceTimersByTimeAsync(PUSH_IDLE_MS + 500)
  await engine.idle()
  body = `${body}more`
  await notes.setBody(id, body)
  await notes.flush()
  await vi.advanceTimersByTimeAsync(PUSH_IDLE_MS + 500)
  await engine.idle()
  expect(records.filter((r) => r.id === id)).toHaveLength(1)
  await engine.syncNow()
  const mine = records.filter((r) => r.id === id)
  expect(mine).toHaveLength(2)
  expect(bodyOf(id, mine.at(-1)!.plaintext)).toBe(body)
  await engine.stop()
})

it('stamps a large note edited offline at its pace, not at every pause', async () => {
  const transport: SyncTransport = {
    connect: async () => {
      throw new Error('E_SYNC_OFFLINE')
    },
    pull: async (since) => ({ records: [], next: since, more: false }),
    push: async () => ({ type: 'failed', code: 'E_SYNC_OFFLINE' }),
    pushMany: (items) => pushOneByOne(transport.push, items),
    close: async () => {},
  }
  const { engine, notes } = await typingSetup(transport)
  let body = largeBody()
  const id = await notes.create('Large')
  await notes.setBody(id, body)
  await notes.flush()
  await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS + 1_000)
  await engine.idle()
  const read = vi.spyOn(storage, 'syncRead')
  for (let at = 0; at < 30_000; at += 4_500) {
    body = `${body.slice(0, 500)}x${body.slice(500)}`
    await notes.setBody(id, body)
    await vi.advanceTimersByTimeAsync(4_500)
  }
  await engine.idle()
  const reads = read.mock.calls.filter(([ids]) => ids.includes(id)).length
  expect(reads).toBeGreaterThan(0)
  // A note of 1 MB waits about 10 s between reads.
  expect(reads).toBeLessThanOrEqual(Math.ceil(30_000 / PUSH_EVERY_MS) + 1)
  read.mockRestore()
  await engine.stop()
})

it('paces only a note that would wait longer than the idle wait, and none past a minute', () => {
  expect(pushPaceMs(250_000)).toBe(0)
  expect(pushPaceMs(2_000_000)).toBe(20_000)
  expect(pushPaceMs(50_000_000)).toBe(60_000)
})
