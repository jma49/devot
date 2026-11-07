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
  type SyncEngine,
} from '../../src/core/sync/engine'
import { decodeRecord } from '../../src/core/sync/records'
import { pushOneByOne, type SyncTransport } from '../../src/core/sync/transport'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { FakeTransport, FakeVault } from '../support/sync-fake'
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

/** About 1.5 MB of Markdown: a large note, whose whole state each push carries (paced to about 15 s). */
const largeBody = () => {
  let md = ''
  for (let i = 0; md.length < 1_500_000; i += 1) {
    md += `## Part ${i}\n\nSome **bold** words and a [link](https://example.com/${i}).\n\n- one\n- two\n\n`
  }
  return md
}

// A note this large takes a while to save and diff on a busy machine.
const LARGE_MS = 30_000

const opened: SqliteAdapter[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

async function typingSetup(
  transport: SyncTransport,
  { name = 'mac', on = storage, via }: { name?: string; on?: SqliteAdapter; via?: 'icloud' } = {},
) {
  const clock = createClock(name)
  const newId = createIdGenerator()
  const engine = createSyncEngine({
    storage: on,
    sync: on,
    transport,
    clock,
    newId,
    random: () => 0.5,
    ...(via ? { via } : {}),
  })
  if (transport instanceof FakeTransport) transport.onEvent = (event) => engine.received(event)
  const notes = createNoteService({
    storage: observeWrites(on, () => engine.touch()),
    clock,
    newId,
    saveDelayMs: 300,
  })
  engine.start()
  await engine.idle()
  return { engine, notes, storage: on }
}

/** A large note the engine has just pushed, so its next push waits out its pace. */
async function pushedLarge(
  notes: Awaited<ReturnType<typeof typingSetup>>['notes'],
  engine: SyncEngine,
) {
  const body = largeBody()
  const id = await notes.create('Large')
  await notes.setBody(id, body)
  await notes.flush()
  await vi.advanceTimersByTimeAsync(PUSH_IDLE_MS + 500)
  await engine.idle()
  return { id, body }
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

it(
  'paces a large note by its size while typing pauses come and go, and sends the last edit',
  { timeout: LARGE_MS },
  async () => {
    const { transport, records } = stubRelay()
    const { engine, notes } = await typingSetup(transport)
    let { id, body } = await pushedLarge(notes, engine)
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
    // About 1.5 MB of state waits 15 s between pushes; pushed at every pause it went 14 times.
    for (let at = 1; at < mine.length; at += 1) {
      expect(mine[at]!.at - mine[at - 1]!.at).toBeGreaterThanOrEqual(15_000)
    }
    expect(mine.length).toBeLessThanOrEqual(6)
    expect(bodyOf(id, mine.at(-1)!.plaintext)).toBe(body)
    await engine.stop()
  },
)

it('pushes a paced note at once on Sync Now', { timeout: LARGE_MS }, async () => {
  const { transport, records } = stubRelay()
  const { engine, notes } = await typingSetup(transport)
  let { id, body } = await pushedLarge(notes, engine)
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

it(
  'does not say a paced note is synced, and sends it when the app is hidden or quits',
  { timeout: LARGE_MS },
  async () => {
    const { transport, records } = stubRelay()
    const { engine, notes } = await typingSetup(transport)
    let { id, body } = await pushedLarge(notes, engine)
    body = `${body}The last paragraph.\n`
    await notes.setBody(id, body)
    await notes.flush()
    const editedAt = Date.now()
    await vi.advanceTimersByTimeAsync(10_000)
    await engine.idle()
    expect(records.filter((r) => r.id === id)).toHaveLength(1)
    expect(engine.status().lastSync ?? 0).toBeLessThan(editedAt)
    await engine.flush()
    const mine = records.filter((r) => r.id === id)
    expect(mine).toHaveLength(2)
    expect(bodyOf(id, mine.at(-1)!.plaintext)).toBe(body)
    expect(engine.status()).toMatchObject({ state: 'idle' })
    expect(engine.status().lastSync ?? 0).toBeGreaterThan(editedAt)
    // Nothing waits any more: a second flush sends nothing.
    await engine.flush()
    expect(records.filter((r) => r.id === id)).toHaveLength(2)
    await engine.stop()
  },
)

it(
  'keeps a note trashed on another device after an edit made here before the trash',
  { timeout: LARGE_MS },
  async () => {
    const vault = new FakeVault()
    vault.maxBytes = 20_000_000
    const phoneStore = openSqliteAdapter(join(tempDir('devot-sync-timing-phone-'), 'db.sqlite'))
    opened.push(phoneStore)
    const mac = await typingSetup(new FakeTransport(vault))
    const phone = await typingSetup(new FakeTransport(vault), { name: 'phone', on: phoneStore })
    let { id, body } = await pushedLarge(mac.notes, mac.engine)
    await phone.engine.syncNow()
    await phone.notes.mergeStored()
    expect((await phoneStore.getNote(id, { trashed: true }))?.bodyMd).toBe(body)

    // The Mac adds a line and stops typing; within the Mac's pace, the phone trashes the note.
    body = `${body}An edit before the trash.\n`
    await mac.notes.setBody(id, body)
    await mac.notes.flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await mac.engine.idle()
    await phone.engine.syncNow()
    await phone.notes.mergeStored()
    await phone.notes.trash(id)
    await phone.notes.flush()
    await phone.engine.syncNow()
    await vi.advanceTimersByTimeAsync(2 * PUSH_EVERY_MS + 60_000)
    await mac.engine.idle()
    await mac.engine.syncNow()
    await mac.notes.mergeStored()
    await phone.engine.syncNow()
    await phone.notes.mergeStored()
    const onMac = await storage.getNote(id, { trashed: true })
    const onPhone = await phoneStore.getNote(id, { trashed: true })
    await mac.engine.stop()
    await phone.engine.stop()
    expect(onMac?.bodyMd).toBe(body)
    expect({ mac: onMac?.deletedAt !== null, phone: onPhone?.deletedAt !== null }).toEqual({
      mac: true,
      phone: true,
    })
  },
)

it(
  'ends a pace that a clock set back would stretch past a minute',
  { timeout: LARGE_MS },
  async () => {
    const { transport, records } = stubRelay()
    const { engine, notes } = await typingSetup(transport)
    let { id, body } = await pushedLarge(notes, engine)
    body = `${body}more`
    await notes.setBody(id, body)
    await notes.flush()
    vi.setSystemTime(Date.now() - 4 * 60_000)
    await vi.advanceTimersByTimeAsync(15_000 + PUSH_IDLE_MS)
    await engine.idle()
    const mine = records.filter((r) => r.id === id)
    expect(mine).toHaveLength(2)
    expect(bodyOf(id, mine.at(-1)!.plaintext)).toBe(body)
    await engine.stop()
  },
)

it(
  'stamps a large note edited offline at its pace, not at every pause',
  { timeout: LARGE_MS },
  async () => {
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
    let { id, body } = await pushedLarge(notes, engine)
    await vi.advanceTimersByTimeAsync(PUSH_EVERY_MS)
    await engine.idle()
    const read = vi.spyOn(storage, 'syncRead')
    for (let at = 0; at < 40_000; at += 4_500) {
      body = `${body.slice(0, 500)}x${body.slice(500)}`
      await notes.setBody(id, body)
      await vi.advanceTimersByTimeAsync(4_500)
    }
    await engine.idle()
    const reads = read.mock.calls.filter(([ids]) => ids.includes(id)).length
    // A note of 1.5 MB waits 15 s between reads; read at every pause it was read 9 times.
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(4)
    read.mockRestore()
    await engine.stop()
  },
)

it('paces only a note that would wait longer than a run of writes does, and none past a minute', () => {
  expect(pushPaceMs(250_000)).toBe(0)
  expect(pushPaceMs(1_000_000)).toBe(0)
  expect(pushPaceMs(2_000_000)).toBe(20_000)
  expect(pushPaceMs(50_000_000)).toBe(60_000)
})
