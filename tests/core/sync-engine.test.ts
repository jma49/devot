// Two devices sync through the Node relay, started in-process: each runs the core's note, notebook
// and tag services and the sync engine on its own better-sqlite3 database, as the app does with
// Rust's storage and transport. Every test ends with both devices holding the same notes.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  attribute,
  BODY,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  MERGE,
  newWriter,
  readWrites,
  seedWelcome,
  type StorageAdapter,
  type WelcomeContent,
} from '../../src/core'
import {
  createSyncEngine,
  type SyncEngineOptions,
  type SyncStatus,
} from '../../src/core/sync/engine'
import { startNodeRelay, type NodeRelay, type NodeRelayOptions } from '../../relay/src/node/server'
import { createVault, enrolled, type RelayHost, type TestVault } from '../relay/client'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { windowsOn } from '../support/note-windows'
import { RelayTransport, type RelayTransportOptions } from '../support/sync-relay'
import { tempDir } from '../support/temp-dirs'

const SECRET = 'test-relay-secret-0123456789abcdef'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

interface Relay {
  host: RelayHost
  node: NodeRelay
  data: string
}

async function startRelay(
  data = tempDir('devot-sync-relay-'),
  options: Pick<NodeRelayOptions, 'quota' | 'now'> = {},
): Promise<Relay> {
  const node = await startNodeRelay({ data, secret: SECRET, ...options })
  const relay = { host: { ...node, secret: SECRET }, node, data }
  cleanups.push(() => relay.node.close())
  return relay
}

type Device = Awaited<ReturnType<typeof device>>

interface DeviceOptions {
  now?: () => number
  transport?: Partial<RelayTransportOptions>
  /** The storage the engine writes through, in place of the device's own. */
  engineStorage?: (storage: SqliteAdapter) => StorageAdapter
  /** Notes in a main window, whose core syncs, and a note window, each with a core of its own. */
  windows?: true
  engine?: Partial<SyncEngineOptions>
}

async function device(
  name: string,
  relay: Relay,
  vault: TestVault,
  token: string,
  options: DeviceOptions = {},
) {
  const storage: SqliteAdapter = openSqliteAdapter(
    join(tempDir(`devot-sync-${name}-`), 'db.sqlite'),
  )
  cleanups.push(() => storage.close())
  const clock = createClock(name)
  const newId = createIdGenerator()
  const app = options.windows ? windowsOn(storage, ['main', 'note'], { saveDelayMs: 5 }) : undefined
  const notes =
    app?.windows[0]?.notes ?? createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const credentials = { relay, token }
  const transport = new RelayTransport({
    url: () => credentials.relay.host.url,
    vault: vault.vault,
    token: () => credentials.token,
    ...options.transport,
  })
  const statuses: SyncStatus[] = []
  const startEngine = () => {
    const engine = createSyncEngine({
      storage: options.engineStorage?.(storage) ?? storage,
      sync: storage,
      transport,
      clock,
      newId,
      retryBaseMs: 1,
      idleMs: 10,
      everyMs: 40,
      random: () => 0.5,
      ...(options.now ? { now: options.now } : {}),
      ...options.engine,
      onStatus: (status) => {
        statuses.push(status)
        options.engine?.onStatus?.(status)
      },
    })
    transport.onEvent = (event) => engine.received(event)
    engine.start()
    cleanups.push(() => engine.stop())
    return engine
  }
  const self = {
    name,
    storage,
    notes,
    books,
    tags,
    clock,
    engine: startEngine(),
    transport,
    statuses,
    credentials,
    app,
    /** Saves, pulls and pushes, then lets the note service take in what came. */
    async sync() {
      await notes.flush()
      await self.engine.syncNow()
      await notes.mergeStored()
    },
    note: (id: string) => storage.getNote(id, { trashed: true }),
    /** Quits and starts again on the same database, as the app does on a relaunch. */
    async restart() {
      await self.engine.stop()
      self.engine = startEngine()
      await self.engine.idle()
    },
  }
  await self.engine.idle()
  return self
}

async function pair(options: { a?: DeviceOptions; b?: DeviceOptions } = {}) {
  const relay = await startRelay()
  const vault = await createVault(relay.host, 'mac')
  const phone = await enrolled(relay.host, vault, 'phone')
  const a = await device('mac', relay, vault, vault.first.token, options.a)
  const b = await device('phone', relay, vault, phone.token, options.b)
  return { relay, vault, a, b }
}

/** Rounds of A then B, so each takes in what the other pushed. */
async function settle(...devices: Device[]) {
  for (let round = 0; round < 2; round += 1) {
    for (const d of devices) await d.sync()
  }
}

async function sameNote(a: Device, b: Device, id: string) {
  const [x, y] = await Promise.all([a.note(id), b.note(id)])
  const view = (n: Awaited<ReturnType<Device['note']>>) =>
    n && {
      title: n.title,
      bodyMd: n.bodyMd,
      bookId: n.bookId,
      status: n.status,
      pinned: n.pinned,
      trashed: n.deletedAt !== null,
    }
  expect(view(x)).toEqual(view(y))
  return x
}

describe('sync between two devices', () => {
  it('brings a new note, then an edit, to the other device', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Groceries')
    await a.notes.setBody(id, 'Milk and eggs.\n')
    await settle(a, b)
    expect((await b.note(id))?.bodyMd).toBe('Milk and eggs.\n')
    await b.notes.setBody(id, 'Milk, eggs and bread.\n')
    await settle(b, a)
    expect((await a.note(id))?.bodyMd).toBe('Milk, eggs and bread.\n')
    await sameNote(a, b, id)
    expect(a.engine.status()).toMatchObject({ state: 'idle', code: null })
    expect(a.engine.status().lastSync).toEqual(expect.any(Number))
  })

  it('stamps the last sync when a pass only pushes', async () => {
    const clock = { now: Date.now() }
    const { a } = await pair({ a: { now: () => clock.now } })
    await a.sync()
    const first = a.engine.status().lastSync
    clock.now += 3_600_000
    await a.notes.create('Typed while the others sleep')
    await a.notes.flush()
    a.engine.touch()
    await vi.waitFor(() => expect(a.engine.status().lastSync).toBe(clock.now))
    expect(first).not.toBe(clock.now)
    expect((await a.storage.syncState())['lastSync']).toBe(String(clock.now))
  })

  it('pushes a record only when it changed', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Once')
    await settle(a, b)
    const pushes = a.transport.pushes + b.transport.pushes
    await settle(a, b)
    expect(a.transport.pushes + b.transport.pushes).toBe(pushes)
    await sameNote(a, b, id)
  })

  it('merges edits both devices made offline, each once, and keeps the local text as a merge', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Plan')
    await a.notes.setBody(id, 'Monday\n\nTuesday\n\nWednesday\n')
    await settle(a, b)
    await a.notes.setBody(id, 'Monday: gym\n\nTuesday\n\nWednesday\n')
    await b.notes.setBody(id, 'Monday\n\nTuesday\n\nWednesday: dentist\n')
    await settle(a, b)
    const note = await sameNote(a, b, id)
    expect(note?.bodyMd).toBe('Monday: gym\n\nTuesday\n\nWednesday: dentist\n')
    const kept = (await b.storage.listRevisions(id)).filter((r) => r.value === MERGE)
    expect(kept).toHaveLength(1)
    const version = await b.storage.getRevision(kept[0]!.id)
    expect(version?.length).toBe('Monday\n\nTuesday\n\nWednesday: dentist\n'.length)
    // A took in B's paragraph: its text from before is kept too.
    const before = (await a.storage.listRevisions(id)).filter((r) => r.value === MERGE)
    expect(before.map((r) => r.length)).toEqual(['Monday: gym\n\nTuesday\n\nWednesday\n'.length])
  })

  it('keeps the text from before another device’s change, at most every ten minutes', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Trip')
    await a.notes.setBody(id, 'Passport\n\nTickets\n\nCharger\n')
    await settle(a, b)
    const merges = async () =>
      (await b.storage.listRevisions(id)).filter((r) => r.kind === 'body' && r.value === MERGE)
    expect(await merges()).toEqual([])
    await a.notes.setBody(id, 'Passport\n\nCharger\n')
    await settle(a, b)
    expect((await b.note(id))?.bodyMd).toBe('Passport\n\nCharger\n')
    const [first] = await merges()
    expect((await b.storage.getRevision(first!.id))?.length).toBe(
      'Passport\n\nTickets\n\nCharger\n'.length,
    )
    await a.notes.setBody(id, 'Passport\n\nCharger\n\nBooks\n')
    await settle(a, b)
    expect(await merges()).toHaveLength(1)
    // Ten minutes on, the next change from the other device keeps a version again.
    const kept = (await b.storage.getRevision(first!.id))!
    await b.storage.deleteRevisions(id, [first!.id])
    await b.storage.putRevision({ ...kept, at: kept.at - 10 * 60_000 })
    await a.notes.setBody(id, 'Passport\n\nBooks\n')
    await settle(a, b)
    const after = await merges()
    expect(after).toHaveLength(2)
    expect(after.map((r) => r.length)).toContain('Passport\n\nCharger\n\nBooks\n'.length)
    await sameNote(a, b, id)
  })

  it('takes the newer value of each metadata field', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Draft')
    await settle(a, b)
    await a.notes.setTitle(id, 'Old title')
    await a.notes.setStatus(id, 'active')
    await a.notes.flush()
    // Later by the wall clock, so later by HLC whatever the counters say.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await b.notes.setTitle(id, 'New title')
    await b.notes.setPinned(id, true)
    await settle(a, b)
    const note = await sameNote(a, b, id)
    expect(note).toMatchObject({ title: 'New title', status: 'active', pinned: true })
  })

  it('brings a note edited after it went to the Trash back out, on both devices', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Ideas')
    await a.notes.setBody(id, 'One\n')
    await settle(a, b)
    await a.notes.trash(id)
    await a.sync()
    await b.notes.setBody(id, 'One\nTwo\n')
    await settle(b, a)
    const note = await sameNote(a, b, id)
    expect(note).toMatchObject({ deletedAt: null, bodyMd: 'One\nTwo\n' })
  })

  it('keeps a note in the Trash when the edit came before the move', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Old')
    await settle(a, b)
    await b.notes.setBody(id, 'Typed before\n')
    await b.notes.flush()
    await b.engine.syncNow()
    await a.sync()
    await a.notes.trash(id)
    await settle(a, b)
    const note = await sameNote(a, b, id)
    expect(note?.deletedAt).not.toBeNull()
    expect(note?.bodyMd).toBe('Typed before\n')
  })

  it('purges a note on the other device, keeping its local copy as a merge version', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Secret')
    await a.notes.setBody(id, 'Shred me\n')
    await settle(a, b)
    await a.notes.trash(id)
    await a.notes.purge(id)
    await settle(a, b)
    expect(await a.note(id)).toBeNull()
    expect(await b.note(id)).toBeNull()
    const [row] = await b.storage.syncRead([id])
    expect(row?.note?.purged).toBe(true)
    const kept = await b.storage.listRevisions(id)
    expect(kept.map((r) => r.value)).toContain(MERGE)
    // A purge is final: an edit B still had in memory does not bring the note back.
    await settle(b, a)
    expect(await a.note(id)).toBeNull()
  })

  it('syncs notebooks and tags with the notes in them', async () => {
    const { a, b } = await pair()
    const book = await a.books.create('Work', null)
    const id = await a.notes.create('Standup', book)
    const tag = await a.tags.addToNote(id, 'daily')
    await settle(a, b)
    expect((await b.books.list()).map((x) => x.name)).toContain('Work')
    expect((await b.storage.getNoteTag(id, tag))?.present).toBe(true)
    await b.tags.rename(tag, 'every day')
    await b.books.rename(book, 'Office')
    await settle(b, a)
    expect((await a.tags.list()).find((t) => t.id === tag)?.name).toBe('every day')
    expect((await a.books.list()).find((x) => x.id === book)?.name).toBe('Office')
    await a.tags.remove(tag)
    await settle(a, b)
    expect((await b.tags.list()).find((t) => t.id === tag)).toBeUndefined()
    await sameNote(a, b, id)
  })

  it('catches up after the relay was away', async () => {
    const { relay, a, b } = await pair()
    const id = await a.notes.create('Trip')
    await settle(a, b)
    await relay.node.close()
    await a.notes.setBody(id, 'Packed on the train\n')
    await a.sync()
    expect(a.engine.status().state).toBe('offline')
    const back = await startNodeRelay({ data: relay.data, secret: SECRET, port: 0 })
    cleanups.push(() => back.close())
    a.credentials.relay = { ...relay, node: back, host: { ...back, secret: SECRET } }
    b.credentials.relay = a.credentials.relay
    await settle(a, b)
    expect((await b.note(id))?.bodyMd).toBe('Packed on the train\n')
  })

  it('uploads everything again to a relay with a new vault epoch', async () => {
    const { vault, a, b } = await pair()
    const id = await a.notes.create('Kept')
    await settle(a, b)
    // The relay lost its data: the vault is made again under the same ID, with a new epoch.
    const fresh = await startRelay()
    const again = await postCreate(fresh.host, vault)
    const phone = await enrolled(fresh.host, vault, 'phone')
    a.credentials.relay = fresh
    a.credentials.token = again.token
    b.credentials.relay = fresh
    b.credentials.token = phone.token
    await a.engine.stop()
    await b.engine.stop()
    a.engine.start()
    b.engine.start()
    await a.engine.idle()
    await b.engine.idle()
    await b.notes.setBody(id, 'Edited after the reset\n')
    await settle(a, b)
    expect((await a.note(id))?.bodyMd).toBe('Edited after the reset\n')
    const c = await device('ipad', fresh, vault, (await enrolled(fresh.host, vault, 'ipad')).token)
    await c.sync()
    expect((await c.note(id))?.title).toBe('Kept')
  })

  it('refuses to sync while the clock is more than 5 minutes off the relay', async () => {
    const { a, b } = await pair({ b: { now: () => Date.now() + 6 * 60_000 } })
    const id = await b.notes.create('Wrong clock')
    await b.sync()
    expect(b.engine.status()).toMatchObject({ state: 'stopped', code: 'E_SYNC_CLOCK_SKEW' })
    expect(b.transport.pushes).toBe(0)
    await a.sync()
    expect(await a.note(id)).toBeNull()
  })

  it('pulls, merges and pushes again when another device pushed first', async () => {
    let race: Device | undefined
    const { a, b } = await pair({
      b: {
        transport: {
          beforePush: async () => {
            const other = race
            race = undefined
            if (other) await other.sync()
          },
        },
      },
    })
    const id = await a.notes.create('Shared')
    await a.notes.setBody(id, 'Start\n')
    await settle(a, b)
    await a.notes.setBody(id, 'Start\nFrom the Mac\n')
    await a.notes.flush()
    await b.notes.setBody(id, 'From the phone\nStart\n')
    race = a
    const pushes = b.transport.pushes
    await b.sync()
    expect(b.transport.pushes - pushes).toBe(2)
    await settle(a, b)
    expect((await sameNote(a, b, id))?.bodyMd).toBe('From the phone\nStart\nFrom the Mac\n')
  })

  it('pulls a record again when local writes kept racing it, instead of skipping it', async () => {
    const racing = { on: false }
    const { a, b } = await pair({
      b: {
        engineStorage: (storage) =>
          new Proxy(storage, {
            get: (target, key, receiver) =>
              key === 'putNote' && racing.on
                ? () => Promise.reject(new Error('E_NOTE_BODY_STALE'))
                : Reflect.get(target, key, receiver),
          }),
      },
    })
    const id = await a.notes.create('Shelf')
    await a.notes.setBody(id, 'One\n')
    await settle(a, b)
    racing.on = true
    await a.notes.setBody(id, 'One\n\nTwo\n')
    await a.sync()
    await b.sync()
    await b.engine.idle()
    expect((await b.note(id))?.bodyMd).toBe('One\n')
    expect(b.engine.status().state).toBe('offline')
    racing.on = false
    await settle(b, a)
    expect((await b.note(id))?.bodyMd).toBe('One\n\nTwo\n')
    await sameNote(a, b, id)
  })

  it('stops pushing a record after 5 retries until the next change on the relay', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Contested')
    await settle(a, b)
    const push = a.transport.push.bind(a.transport)
    let rejecting = true
    a.transport.push = async (record, base, plaintext) =>
      rejecting ? { type: 'rejected', version: base + 1 } : push(record, base, plaintext)
    await a.notes.setTitle(id, 'Mine')
    const before = a.transport.pulls
    await a.sync()
    expect(a.transport.pulls - before).toBe(1 + 5)
    await a.sync()
    expect(a.transport.pulls - before).toBe(1 + 5 + 1)
    rejecting = false
    await b.notes.setTitle(id, 'Theirs, later')
    await b.sync()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await a.engine.idle()
    await settle(a, b)
    expect((await sameNote(a, b, id))?.title).toBe('Theirs, later')
  })

  it('stops and says so when the device is revoked', async () => {
    const { a, b } = await pair()
    const devices = (await b.transport.send({ type: 'devices' }))['devices'] as {
      id: string
      current: boolean
    }[]
    const phone = devices.find((d) => d.current)!.id
    await a.transport.send({ type: 'revoke', device: phone })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await b.engine.idle()
    expect(b.engine.status()).toMatchObject({ state: 'stopped', code: 'E_SYNC_REVOKED' })
    const id = await b.notes.create('Not sent')
    await b.sync()
    expect(b.engine.status().code).toBe('E_SYNC_REVOKED')
    await a.sync()
    expect(await a.note(id)).toBeNull()
  })

  it('keeps a record past the relay’s size limit on this device, with a notice', async () => {
    const { a, b } = await pair({ a: { transport: { chunkBytes: 64 } } })
    const small = await a.notes.create('S')
    const big = await a.notes.create('Long')
    await a.notes.setBody(big, 'x'.repeat(2000))
    await settle(a, b)
    expect(a.engine.status().tooLarge).toEqual([big])
    expect(await b.note(big)).toBeNull()
    expect((await a.note(big))?.bodyMd).toBe('x'.repeat(2000))
    expect(a.statuses.some((s) => s.tooLarge.includes(big))).toBe(true)
    void small
  })

  it('does not announce an upload for records the relay refused as too large', async () => {
    const { a, b } = await pair({
      a: { transport: { chunkBytes: 64 }, engine: { uploadShownFrom: 5 } },
    })
    for (let i = 0; i < 6; i++) {
      const id = await a.notes.create(`Long ${i}`)
      await a.notes.setBody(id, 'x'.repeat(2000))
    }
    await settle(a, b)
    expect(a.engine.status().tooLarge).toHaveLength(6)
    a.statuses.length = 0
    await a.engine.syncNow()
    await a.engine.idle()
    expect(a.statuses.filter((s) => s.upload !== null)).toEqual([])
    expect((await a.storage.syncState())['uploadTotal'] ?? '0').toBe('0')
  })

  it('clears the too-large notice when the relay has a new vault epoch', async () => {
    const { vault, a } = await pair({ a: { transport: { chunkBytes: 64 } } })
    const big = await a.notes.create('Long')
    await a.notes.setBody(big, 'x'.repeat(2000))
    await a.sync()
    expect(a.engine.status().tooLarge).toEqual([big])
    const fresh = await startRelay()
    const again = await postCreate(fresh.host, vault)
    a.credentials.relay = fresh
    a.credentials.token = again.token
    await a.engine.stop()
    await a.notes.setBody(big, 'short\n')
    await a.notes.flush()
    a.engine.start()
    await a.engine.idle()
    expect(a.engine.status().tooLarge).toEqual([])
  })

  it('takes the other device’s copy of a first-launch note nobody edited', async () => {
    const welcome = (body: string): WelcomeContent => ({
      bookName: 'Getting started',
      notes: [{ id: '00000000-0000-7000-8000-0000000000c1', title: 'Welcome', body }],
    })
    const relay = await startRelay()
    const vault = await createVault(relay.host)
    const phone = await enrolled(relay.host, vault)
    const a = await device('mac', relay, vault, vault.first.token)
    const b = await device('phone', relay, vault, phone.token)
    for (const [d, text] of [
      [a, 'Press Cmd+N for a new note.\n'],
      [b, 'Tap + for a new note.\n'],
    ] as const) {
      await seedWelcome({
        storage: d.storage,
        clock: d.clock,
        newId: createIdGenerator(),
        content: welcome(text),
      })
    }
    await settle(a, b)
    const note = await sameNote(a, b, '00000000-0000-7000-8000-0000000000c1')
    expect(note?.bodyMd).toBe('Press Cmd+N for a new note.\n')
    // Nobody wrote the welcome that gave way: there is no text of the user's to keep.
    const kept = await b.storage.listRevisions('00000000-0000-7000-8000-0000000000c1')
    expect(kept.filter((r) => r.value === MERGE)).toEqual([])
  })
})

describe('what the relay announces and what this build cannot read', () => {
  it('answers a burst of change events with one pass, not one pass each', async () => {
    const { a, b } = await pair()
    await b.notes.create('Burst')
    await b.sync()
    const pull = a.transport.pull.bind(a.transport)
    let pulls = 0
    a.transport.pull = async (since) => {
      pulls += 1
      return pull(since)
    }
    for (let seq = 1; seq <= 50; seq += 1) a.engine.received({ type: 'changed', seq })
    await a.engine.idle()
    // One pass for the burst, one more at most for an event that came while it ran.
    expect(pulls).toBeLessThanOrEqual(2)
    expect((await a.storage.listNotes()).map((n) => n.title)).toContain('Burst')
  })

  it('pulls a record again after an update, when this build could not read it', async () => {
    const cfg = { build: '1.0.0' }
    const { a, b } = await pair({ a: { engine: cfg } })
    const id = await b.notes.create('From the future')
    await b.sync()
    const pull = a.transport.pull.bind(a.transport)
    const sinces: number[] = []
    let unreadable = true
    a.transport.pull = async (since) => {
      sinces.push(since)
      const page = await pull(since)
      if (!unreadable) return page
      const records = page.records.map(({ plaintext: _gone, ...rest }) => ({
        ...rest,
        error: 'E_SYNC_RECORD_INVALID',
      }))
      return { ...page, records }
    }
    await a.sync()
    expect(await a.note(id)).toBeNull()
    unreadable = false
    await a.sync()
    expect(await a.note(id)).toBeNull()
    // The same build does not pull everything again on a restart.
    sinces.length = 0
    await a.restart()
    expect(sinces.every((since) => since > 0)).toBe(true)
    cfg.build = '1.1.0'
    await a.restart()
    expect(sinces).toContain(0)
    await a.sync()
    expect((await a.note(id))?.title).toBe('From the future')
  })

  it('does not pull everything again after an update when nothing was skipped', async () => {
    const cfg = { build: '1.0.0' }
    const { a, b } = await pair({ a: { engine: cfg } })
    await b.notes.create('Fine')
    await b.sync()
    await a.sync()
    const pull = a.transport.pull.bind(a.transport)
    const sinces: number[] = []
    a.transport.pull = async (since) => {
      sinces.push(since)
      return pull(since)
    }
    cfg.build = '1.1.0'
    await a.restart()
    expect(sinces.every((since) => since > 0)).toBe(true)
  })
})

describe('the relay’s quota cap', () => {
  /** A relay with these caps, on a clock the test moves; while `jump` is on, a pause lets the clock run to the reset. */
  async function cappedPair(start: number, caps: { rowsWritten?: number; storedBytes?: number }) {
    const time = { now: start, jump: false }
    const now = () => time.now
    const quota = { rowsWritten: 1e9, requests: 1e9, storedBytes: 1e12, ...caps }
    const relay = await startRelay(undefined, { quota, now })
    const vault = await createVault(relay.host, 'mac')
    const phone = await enrolled(relay.host, vault, 'phone')
    const a = await device('mac', relay, vault, vault.first.token, {
      now,
      engine: {
        quotaJitterMs: 10,
        uploadShownFrom: 5,
        onStatus: (status) => {
          if (time.jump && status.pausedUntil !== null) time.now = status.pausedUntil
        },
      },
    })
    const b = await device('phone', relay, vault, phone.token, { now })
    return { time, quota, a, b }
  }

  const resumed = (d: Device) =>
    vi.waitFor(() => expect(d.engine.status().state).toBe('idle'), { timeout: 10_000 })

  it('pauses pushes until 00:00 UTC, says when, and goes on by itself after it', async () => {
    const midnight = Date.UTC(2026, 9, 24)
    const { time, a, b } = await cappedPair(midnight - 300, { rowsWritten: 24 })
    const ids: string[] = []
    for (let i = 0; i < 8; i++) ids.push(await a.notes.create(`Note ${i}`))
    await a.sync()
    await a.engine.idle()
    expect(a.engine.status()).toMatchObject({
      state: 'paused',
      code: 'E_SYNC_QUOTA',
      pausedUntil: midnight,
    })
    const pushes = a.transport.pushes
    time.now = midnight + 1
    await resumed(a)
    expect(a.transport.pushes).toBeGreaterThan(pushes)
    expect(a.engine.status()).toMatchObject({ code: null, pausedUntil: null, upload: null })
    await b.sync()
    for (const id of ids) expect((await b.note(id))?.title).toMatch(/^Note /)
  })

  it('keeps the relay’s reset time when the refusal arrives after it, and goes on within a minute', async () => {
    const midnight = Date.UTC(2026, 9, 24)
    const { time, a } = await cappedPair(midnight - 300, { rowsWritten: 24 })
    const push = a.transport.push.bind(a.transport)
    a.transport.push = async (...args) => {
      const result = await push(...args)
      if (result.type === 'paused') time.now = midnight + 50
      return result
    }
    for (let i = 0; i < 8; i++) await a.notes.create(`Note ${i}`)
    await a.sync()
    await a.engine.idle()
    expect(a.statuses.find((s) => s.state === 'paused')?.pausedUntil).toBe(midnight)
    await resumed(a)
  })

  it('uploads a large vault over several days, with its progress, keeping its place across a restart', async () => {
    const { time, a, b } = await cappedPair(Date.UTC(2026, 9, 23, 12), { rowsWritten: 30 })
    const ids: string[] = []
    for (let i = 0; i < 20; i++) ids.push(await a.notes.create(`Note ${i}`))
    await a.sync()
    await a.engine.idle()
    const paused = a.engine.status()
    expect(paused).toMatchObject({ state: 'paused', pausedUntil: Date.UTC(2026, 9, 24) })
    const sent = paused.upload?.sent ?? 0
    expect(paused.upload?.total).toBe(20)
    expect(sent).toBeGreaterThan(0)
    expect(sent).toBeLessThan(20)

    const from = a.statuses.length
    time.jump = true
    await a.restart()
    await resumed(a)
    const after = a.statuses.slice(from)
    const shown = after.flatMap((s) => (s.upload ? [s.upload] : []))
    expect(shown[0]).toEqual({ sent, total: 20 })
    expect(shown.map((u) => u.sent)).toEqual([...shown.map((u) => u.sent)].sort((x, y) => x - y))
    const days = new Set(after.flatMap((s) => (s.pausedUntil === null ? [] : [s.pausedUntil])))
    expect(days.size).toBeGreaterThan(1)
    expect(a.engine.status()).toMatchObject({ state: 'idle', upload: null })
    const pauses = a.statuses.filter(
      (s, i) => s.state === 'paused' && a.statuses[i - 1]?.state !== 'paused',
    ).length
    // Each pause cost one refused push; no record went twice.
    expect(a.transport.pushes).toBe(20 + pauses)
    await b.sync()
    for (const id of ids) expect((await b.note(id))?.title).toMatch(/^Note /)
  })

  it('still sends smaller records and purges when the relay’s storage is full', async () => {
    const midnight = Date.UTC(2026, 9, 24)
    const { quota, a, b } = await cappedPair(midnight - 3_600_000, {})
    const growing = await a.notes.create('Growing')
    const purged = await a.notes.create('Purged')
    await a.notes.setBody(purged, 'y'.repeat(2000))
    await settle(a, b)
    quota.storedBytes = 1
    await a.notes.setBody(growing, 'x'.repeat(2000))
    await a.notes.trash(purged)
    await a.notes.purge(purged)
    await a.sync()
    await a.engine.idle()
    // Not the daily quota: the reset frees no storage, so the status names its own cause.
    expect(a.engine.status()).toMatchObject({
      state: 'paused',
      code: 'E_SYNC_STORAGE_FULL',
      pausedUntil: midnight,
    })
    await b.sync()
    expect(await b.note(purged)).toBeNull()
    expect((await b.note(growing))?.bodyMd).toBe('')
  })

  it('keeps an upload’s place when the connection drops between two pushes', async () => {
    const { a } = await pair({ a: { engine: { uploadShownFrom: 5 } } })
    for (let i = 0; i < 10; i++) await a.notes.create(`Note ${i}`)
    await a.notes.flush()
    const push = a.transport.push.bind(a.transport)
    a.transport.push = async (...args) => {
      const result = await push(...args)
      if (a.transport.pushes === 3) a.engine.received({ type: 'closed', code: 'E_SYNC_OFFLINE' })
      return result
    }
    await a.engine.syncNow()
    await a.engine.idle()
    expect(a.engine.status()).toMatchObject({ state: 'offline', upload: { sent: 3, total: 10 } })
    expect((await a.storage.syncState())['uploadTotal']).toBe('10')
    await vi.waitFor(() => expect(a.engine.status().state).toBe('idle'), { timeout: 10_000 })
    expect(a.engine.status().upload).toBeNull()
    expect(a.transport.pushes).toBe(10)
  })

  it('syncs with a relay from before the cap as before, and says to update it', async () => {
    const { a, b } = await pair({
      a: { transport: { welcome: (welcome) => ({ ...welcome, quota: null }) } },
    })
    const id = await a.notes.create('Older relay')
    await settle(a, b)
    expect(a.engine.status()).toMatchObject({ state: 'idle', relayOutdated: true })
    expect(b.engine.status().relayOutdated).toBe(false)
    expect((await b.note(id))?.title).toBe('Older relay')
  })
})

describe('sync with a note open in its own window', () => {
  it('brings another device’s changes to the note window, whether or not the main window holds the note', async () => {
    const { a, b } = await pair({ b: { windows: true } })
    const app = b.app!
    const [main, own] = app.windows as [(typeof app.windows)[0], (typeof app.windows)[0]]
    const id = await a.notes.create('Plan')
    await a.notes.setBody(id, 'Monday\n')
    await settle(a, b)
    await app.show(own, id)
    await app.deliverAll()

    await a.notes.setBody(id, 'Monday\n\nTuesday\n')
    await a.notes.setTitle(id, 'Week')
    await settle(a, b)
    await app.deliverAll()
    expect(app.editorText(own, id)).toBe('Monday\n\nTuesday\n')
    expect(own.titles.get(id)).toBe('Week')
    // Relayed once per write it has not had.
    await settle(a, b)
    expect(own.inbox).toEqual([])

    await app.show(main, id)
    await app.deliverAll()
    await a.notes.setBody(id, 'Monday\n\nTuesday\n\nWednesday\n')
    await a.notes.setTitle(id, 'Three days')
    await settle(a, b)
    await app.deliverAll()
    expect(app.editorText(own, id)).toBe('Monday\n\nTuesday\n\nWednesday\n')
    expect(app.editorText(main, id)).toBe('Monday\n\nTuesday\n\nWednesday\n')
    expect(own.titles.get(id)).toBe('Three days')
    await sameNote(a, b, id)
  })
})

async function postCreate(host: RelayHost, vault: TestVault) {
  const { enrollmentVerifier, toBase64Url } = await import('../../src/core/sync/protocol')
  const res = await fetch(`${host.url}/v1/vaults/${vault.vault}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${host.secret}` },
    body: JSON.stringify({
      v: 1,
      type: 'create',
      verifier: toBase64Url(await enrollmentVerifier(vault.enrollmentSecret)),
      label: 'mac',
    }),
  })
  return (await res.json()) as { token: string; epoch: string }
}

describe('authorship through sync', () => {
  const claude = newWriter('mcp', 'Claude Code', 'mcp0123456789ab')
  const docOf = async (d: Device, id: string) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, (await d.note(id))!.ydoc)
    return doc
  }
  const agentText = (doc: Y.Doc) => {
    const body = doc.getText(BODY).toString()
    return attribute(doc).map((run) => body.slice(run.from, run.to))
  }

  it('brings the records to the other device, which can undo them, and keeps seen per device', async () => {
    const { a, b } = await pair()
    const id = await a.notes.create('Plan')
    await a.notes.setBody(id, 'Intro.\n')
    await a.notes.agentWrite(id, { writer: claude, markdown: 'Intro.\nThe agent wrote this.\n' })
    await settle(a, b)
    expect(agentText(await docOf(b, id))).toEqual(agentText(await docOf(a, id)))
    expect(agentText(await docOf(b, id))).toEqual(['The agent wrote this.\n'])
    const [row] = await a.storage.listAgentWrites(10)
    await a.storage.markAgentWritesSeen(id, [row!.writeId])
    expect((await b.storage.listAgentWrites(10)).map((r) => [r.writeId, r.seen])).toEqual([
      [row!.writeId, false],
    ])
    await b.notes.setBody(id, 'Intro.\nThe agent wrote this.\nB typed this.\n')
    await b.notes.undoAgentWrites(id, { kind: 'mcp', name: 'Claude Code' })
    await settle(b, a)
    const note = await sameNote(a, b, id)
    expect(note?.bodyMd).toBe('Intro.\nB typed this.\n')
    expect(readWrites(await docOf(a, id))).toEqual([])
    expect(await a.storage.listAgentWrites(10)).toEqual([])
  })
})
