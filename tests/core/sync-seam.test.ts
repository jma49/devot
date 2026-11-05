// The engine behind a transport that is not the relay (docs/adr/0015-sync-through-icloud-with-devots-own-encryption.md,
// Seam changes in the core): cursors and change tags are opaque, backlogs go out in batches, a full
// iCloud pauses with no end, and the moved marker stops a device the vault left. The relay's own
// behaviour is checked against the Node relay: stored cursors keep working and the marker passes it.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
import { createSyncEngine, type SyncEngineOptions } from '../../src/core/sync/engine'
import { encodeMoved, leaveMovedMarker, MOVED_ID } from '../../src/core/sync/moved'
import { decodeRecord } from '../../src/core/sync/records'
import {
  ICLOUD_FULL,
  pushOneByOne,
  VAULT_MOVED,
  type SyncEvent,
  type SyncTransport,
} from '../../src/core/sync/transport'
import { startNodeRelay } from '../../relay/src/node/server'
import { createVault, enrolled, type RelayHost, type TestVault } from '../relay/client'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { FakeTransport, FakeVault } from '../support/sync-fake'
import { RelayTransport, type RelayTransportOptions } from '../support/sync-relay'
import { tempDir } from '../support/temp-dirs'

const SECRET = 'test-relay-secret-0123456789abcdef'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function device<T extends SyncTransport>(
  name: string,
  transport: T & { onEvent: (event: SyncEvent) => void },
  engine: Partial<SyncEngineOptions> = {},
) {
  const storage: SqliteAdapter = openSqliteAdapter(
    join(tempDir(`devot-seam-${name}-`), 'db.sqlite'),
  )
  cleanups.push(() => storage.close())
  const clock = createClock(name)
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const start = () => {
    const started = createSyncEngine({
      storage,
      sync: storage,
      transport,
      clock,
      newId,
      retryBaseMs: 1,
      idleMs: 10,
      everyMs: 40,
      random: () => 0.5,
      ...engine,
    })
    transport.onEvent = (event) => started.received(event)
    started.start()
    cleanups.push(() => started.stop())
    return started
  }
  const self = {
    storage,
    notes,
    transport,
    engine: start(),
    async sync() {
      await notes.flush()
      await self.engine.syncNow()
      await notes.mergeStored()
    },
    note: (id: string) => storage.getNote(id, { trashed: true }),
    entry: async (id: string) => (await storage.syncRead([id]))[0]?.entry ?? null,
    async restart() {
      await self.engine.stop()
      self.engine = start()
      await self.engine.idle()
    },
  }
  return self
}

type Device = ReturnType<typeof device>

async function settle(...devices: Device[]) {
  for (let round = 0; round < 2; round += 1) {
    for (const d of devices) await d.sync()
  }
}

function fakePair(engine: Partial<SyncEngineOptions> = {}) {
  const vault = new FakeVault()
  const a = device('mac', new FakeTransport(vault), engine)
  const b = device('phone', new FakeTransport(vault), engine)
  return { vault, a, b, fa: a.transport, fb: b.transport }
}

async function connected(vault: FakeVault) {
  const transport = new FakeTransport(vault)
  await transport.connect()
  return transport
}

describe('a transport with opaque cursors and change tags', () => {
  it('syncs notes both ways and keeps the cursor and each record’s tag as given', async () => {
    const { vault, a, b, fb } = fakePair()
    const id = await a.notes.create('Groceries')
    await a.notes.setBody(id, 'Milk and eggs.\n')
    await a.notes.create('Second')
    await a.notes.create('Third')
    await settle(a, b)
    expect((await b.note(id))?.bodyMd).toBe('Milk and eggs.\n')
    await b.notes.setBody(id, 'Milk, eggs and bread.\n')
    await settle(b, a)
    expect((await a.note(id))?.bodyMd).toBe('Milk, eggs and bread.\n')
    for (const d of [a, b]) {
      const since = (await d.storage.syncState())['since'] ?? ''
      expect(since).toMatch(/^tok_/)
      expect((await d.entry(id))?.tag).toBe(vault.records.get(id)?.tag)
    }
    expect(fb.cursors.slice(1).every((c) => c === '' || c.startsWith('tok_'))).toBe(true)
    expect(a.engine.status()).toMatchObject({ state: 'idle', code: null })
  })

  it('pulls, merges and pushes again against the tag a rejected push returned', async () => {
    const { vault, a, b, fb } = fakePair()
    const id = await a.notes.create('Shared')
    await a.notes.setBody(id, 'Start\n')
    await settle(a, b)
    await a.notes.setBody(id, 'Start\nFrom the Mac\n')
    await a.notes.flush()
    await b.notes.setBody(id, 'From the phone\nStart\n')
    let race: Device | undefined = a
    let serverTag: string | undefined
    fb.beforePush = async () => {
      const other = race
      race = undefined
      if (!other) return
      await other.sync()
      serverTag = vault.records.get(id)?.tag
    }
    const before = fb.sent.length
    await b.sync()
    const [first, retry] = fb.sent.slice(before)
    expect(first).toMatchObject({ id, base: 1 })
    expect(retry).toMatchObject({ id, base: 2 })
    expect(retry?.tag).not.toBe(first?.tag)
    await settle(a, b)
    expect((await a.note(id))?.bodyMd).toBe('From the phone\nStart\nFrom the Mac\n')
    expect((await b.note(id))?.bodyMd).toBe('From the phone\nStart\nFrom the Mac\n')
    expect(retry?.tag).toBe(serverTag)
  })

  it('carries a purge to the other device', async () => {
    const { a, b } = fakePair()
    const id = await a.notes.create('Going')
    await settle(a, b)
    await a.notes.trash(id)
    await a.notes.purge(id)
    await settle(a, b)
    const gone = await b.storage.syncRead([id])
    expect(gone[0]?.note?.purged).toBe(true)
  })

  it('uploads everything again to a vault with a new epoch, with no tag from before', async () => {
    const { vault, a, b } = fakePair()
    const id = await a.notes.create('Kept')
    await settle(a, b)
    vault.wipe()
    await a.restart()
    await b.restart()
    await settle(a, b)
    expect(vault.records.get(id)?.version).toBe(1)
    const c = device('ipad', new FakeTransport(vault))
    await c.sync()
    expect((await c.note(id))?.title).toBe('Kept')
  })

  it('skips a version it has seen already when the transport replays it', async () => {
    const { vault, a, b, fb } = fakePair()
    const id = await a.notes.create('First title')
    await settle(a, b)
    const old = vault.records.get(id)!
    await a.notes.setTitle(id, 'Second title')
    await settle(a, b)
    fb.tamper = (page) => ({
      ...page,
      records: [
        { id, version: old.version, tag: old.tag, kind: 'record', plaintext: old.plaintext },
      ],
    })
    await b.sync()
    delete fb.tamper
    expect((await b.note(id))?.title).toBe('Second title')
    expect(b.engine.status().skipped).toBe(0)
  })
})

describe('a backlog in batches', () => {
  it('handles each result of a batch as a single push: pushed, rejected and too large', async () => {
    const { vault, a, b, fa } = fakePair({ uploadShownFrom: 3 })
    const shared = await a.notes.create('Shared')
    await settle(a, b)
    await a.notes.setTitle(shared, 'From the Mac')
    const big = await a.notes.create('Too big')
    await a.notes.setBody(big, `${'x'.repeat(4_000)}\n`)
    const small = [await a.notes.create('One'), await a.notes.create('Two')]
    await b.notes.setTitle(shared, 'From the phone, later')
    await b.notes.flush()
    // The phone writes between the Mac's pull and its batch: that one push is rejected.
    let race = true
    fa.beforePush = async () => {
      if (!race) return
      race = false
      await b.engine.syncNow()
    }
    vault.maxBytes = 3_000
    await a.sync()
    delete fa.beforePush
    expect(fa.batches.some((batch) => batch.includes(shared) && batch.includes(big))).toBe(true)
    expect(a.engine.status().tooLarge).toEqual([big])
    for (const id of small) expect(vault.records.get(id)?.version).toBe(1)
    expect(vault.records.has(big)).toBe(false)
    await settle(a, b)
    expect((await a.note(shared))?.title).toBe('From the phone, later')
    expect((await b.note(shared))?.title).toBe('From the phone, later')
    expect(await a.storage.syncPendingCount()).toBe(1)
  })

  it('keeps single pushes for a few records', async () => {
    const { a, fa } = fakePair()
    await a.notes.create('Alone')
    await a.sync()
    expect(fa.batches).toEqual([])
    expect(fa.pushes).toBe(1)
  })
})

describe('a full iCloud', () => {
  it('goes on with what fits, pauses with no end, and resumes when looked at again', async () => {
    const { vault, a } = fakePair({ recheckMs: 60_000 })
    let full = true
    vault.refuse = (item) =>
      full && item.plaintext.length > 1_000
        ? { type: 'paused', until: null, code: ICLOUD_FULL }
        : undefined
    const big = await a.notes.create('Big')
    await a.notes.setBody(big, `${'y'.repeat(2_000)}\n`)
    const small = await a.notes.create('Small')
    await a.sync()
    expect(a.engine.status()).toMatchObject({
      state: 'paused',
      code: ICLOUD_FULL,
      pausedUntil: null,
    })
    expect(vault.records.has(small)).toBe(true)
    expect(vault.records.has(big)).toBe(false)
    full = false
    a.engine.focused()
    await vi.waitFor(() => expect(a.engine.status().state).toBe('idle'))
    expect(vault.records.has(big)).toBe(true)
  })

  it('looks again on its own after the recheck interval', async () => {
    const { vault, a } = fakePair({ recheckMs: 30 })
    let full = true
    vault.refuse = () => (full ? { type: 'paused', until: null, code: ICLOUD_FULL } : undefined)
    const id = await a.notes.create('Waiting')
    await a.sync()
    expect(a.engine.status()).toMatchObject({ state: 'paused', code: ICLOUD_FULL })
    full = false
    await vi.waitFor(() => expect(vault.records.has(id)).toBe(true))
    await vi.waitFor(() => expect(a.engine.status().state).toBe('idle'))
  })

  it('waits out a timed pause of another transport exactly, with no daily reset', async () => {
    const { vault, a } = fakePair()
    let paused = true
    const until = Date.now() + 40
    vault.refuse = () =>
      paused ? { type: 'paused', until, code: 'E_SYNC_ICLOUD_BUSY' } : undefined
    const id = await a.notes.create('Later')
    await a.sync()
    expect(a.engine.status()).toMatchObject({
      state: 'paused',
      code: 'E_SYNC_ICLOUD_BUSY',
      pausedUntil: until,
    })
    paused = false
    await vi.waitFor(() => expect(vault.records.has(id)).toBe(true), { timeout: 5_000 })
  })
})

describe('the moved marker', () => {
  it('stops a device whose vault moved to another transport, and changes nothing here', async () => {
    const { vault, a, b } = fakePair()
    const id = await a.notes.create('Before the move')
    await settle(a, b)
    await leaveMovedMarker(await connected(vault), 'icloud')
    expect(vault.records.get(MOVED_ID)?.kind).toBe('record')
    await b.sync()
    await b.engine.idle()
    expect(b.engine.status()).toMatchObject({ state: 'stopped', code: VAULT_MOVED })
    expect(await b.entry(MOVED_ID)).toBeNull()
    expect(await b.note(MOVED_ID)).toBeNull()
    expect((await b.note(id))?.title).toBe('Before the move')
  })

  it('is left alone by a device on the transport it names', async () => {
    const vault = new FakeVault()
    const here = device('mac', new FakeTransport(vault), { via: 'icloud' })
    await leaveMovedMarker(await connected(vault), 'icloud')
    await here.sync()
    expect(here.engine.status()).toMatchObject({ state: 'idle', code: null, skipped: 0 })
    expect(await here.entry(MOVED_ID)).toBeNull()
  })

  it('is never pushed from a local record with its ID', async () => {
    const { vault, a } = fakePair()
    const id = await a.notes.create('Ordinary')
    const note = (await a.note(id))!
    await a.storage.putNote({ ...note, id: MOVED_ID })
    await a.sync()
    expect(vault.records.has(MOVED_ID)).toBe(false)
    expect(vault.records.has(id)).toBe(true)
    expect(await a.storage.syncPendingCount()).toBe(0)
    expect(a.engine.status()).toMatchObject({ state: 'idle', code: null })
  })

  it('is a body today’s decoder refuses, so older builds skip it', () => {
    expect(() => decodeRecord(MOVED_ID, encodeMoved('icloud'))).toThrow('E_SYNC_RECORD_INVALID')
    expect(() => decodeRecord(MOVED_ID, encodeMoved('relay'))).toThrow('E_SYNC_RECORD_INVALID')
  })
})

interface Relay {
  host: RelayHost
  vault: TestVault
}

async function relayPair(options: Partial<RelayTransportOptions> = {}) {
  const node = await startNodeRelay({ data: tempDir('devot-seam-relay-'), secret: SECRET })
  cleanups.push(() => node.close())
  const host = { ...node, secret: SECRET }
  const vault = await createVault(host, 'mac')
  const phone = await enrolled(host, vault, 'phone')
  const transport = (token: string) =>
    new RelayTransport({ url: () => host.url, vault: vault.vault, token: () => token, ...options })
  const relay: Relay = { host, vault }
  return {
    relay,
    a: device('mac', transport(vault.first.token)),
    b: device('phone', transport(phone.token)),
    /** A transport of a third device that runs no engine. */
    async other() {
      const ipad = await enrolled(host, vault, 'ipad')
      const opened = transport(ipad.token)
      await opened.connect()
      cleanups.push(() => opened.close())
      return opened
    },
  }
}

describe('the relay behind the new seam', () => {
  it('keeps a numeric cursor stored before and uploads nothing again', async () => {
    const { a, b } = await relayPair()
    await a.notes.create('Synced before')
    await settle(a, b)
    const stored = (await a.storage.syncState())['since']
    expect(stored).toMatch(/^[1-9]\d*$/)
    const pushes = a.transport.pushes
    const pull = vi.spyOn(a.transport, 'pull')
    await a.restart()
    await a.sync()
    expect(pull.mock.calls[0]?.[0]).toBe(stored)
    expect(a.transport.pushes).toBe(pushes)
  })

  it('reads a stored 0 as the start', async () => {
    const { a, b } = await relayPair()
    const id = await a.notes.create('From the start')
    await settle(a, b)
    await b.storage.syncSetState('since', '0')
    const pull = vi.spyOn(b.transport, 'pull')
    await b.sync()
    expect(pull.mock.calls[0]?.[0]).toBe('')
    expect((await b.note(id))?.title).toBe('From the start')
  })

  it('takes the moved marker unchanged, and a device that pulls it stops', async () => {
    const { a, b, other } = await relayPair()
    const id = await b.notes.create('Stays here')
    await settle(a, b)
    await leaveMovedMarker(await other(), 'icloud')
    await b.sync()
    await b.engine.idle()
    expect(b.engine.status()).toMatchObject({ state: 'stopped', code: VAULT_MOVED })
    expect(await b.entry(MOVED_ID)).toBeNull()
    expect((await b.note(id))?.title).toBe('Stays here')
  })

  it('runs pushMany one push at a time, each with its own result', async () => {
    const { other } = await relayPair({ chunkBytes: 1 })
    const transport = await other()
    const ids = ['0192a6f0-0000-7000-8000-00000000a001', '0192a6f0-0000-7000-8000-00000000a002']
    const small = new Uint8Array([1])
    await transport.push(ids[1]!, 0, small)
    const results = await pushOneByOne(transport.push.bind(transport), [
      { id: ids[0]!, base: 0, tag: '', plaintext: small, kind: 'record' },
      { id: ids[1]!, base: 0, tag: '', plaintext: small, kind: 'record' },
      { id: MOVED_ID, base: 0, tag: '', plaintext: new Uint8Array(40), kind: 'record' },
    ])
    expect(results).toEqual([
      { type: 'pushed', version: 1, seq: expect.any(Number), tag: '' },
      { type: 'rejected', version: 1, tag: '' },
      { type: 'failed', code: 'E_SYNC_TOO_LARGE' },
    ])
  })
})
