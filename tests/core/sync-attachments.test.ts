// Attachments sync as records (docs/adr/0003-sync-attachments-as-records.md): two devices on the
// Node relay, each running the core's services and the sync engine on its own better-sqlite3
// database, as the app does with Rust's storage and transport.
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClock, createIdGenerator, createNoteService, type NoteService } from '../../src/core'
import { createSyncEngine, type SyncEngineOptions } from '../../src/core/sync/engine'
import type { QuotaCaps } from '../../src/core/sync/protocol'
import { decodeRecord, encodeRecord, tombstoneFile } from '../../src/core/sync/records'
import { startNodeRelay, type NodeRelay } from '../../relay/src/node/server'
import { createVault, enrolled, type RelayHost } from '../relay/client'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { RelayTransport, type RelayTransportOptions } from '../support/sync-relay'
import { tempDir } from '../support/temp-dirs'

const SECRET = 'test-relay-secret-0123456789abcdef'
const KB = 1000

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** An image of this many bytes: a PNG signature, then filler that differs per `seed`. */
function image(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) % 251
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return bytes
}

type Quota = { -readonly [K in keyof QuotaCaps]: QuotaCaps[K] }
const ROOMY: Quota = {
  rowsWritten: 1e9,
  requests: 1e9,
  storedBytes: 1e12,
  fileBytes: 3e9,
}

interface Relay {
  host: RelayHost
  node: NodeRelay
}

async function startRelay(quota: Quota | null = ROOMY, now?: () => number): Promise<Relay> {
  const node = await startNodeRelay({
    data: tempDir('devot-sync-files-relay-'),
    secret: SECRET,
    quota,
    ...(now ? { now } : {}),
  })
  cleanups.push(() => node.close())
  return { host: { ...node, secret: SECRET }, node }
}

type Device = Awaited<ReturnType<typeof device>>

interface DeviceOptions {
  transport?: Partial<RelayTransportOptions>
  engine?: Partial<SyncEngineOptions>
  now?: () => number
}

async function device(
  name: string,
  relay: Relay,
  vault: Awaited<ReturnType<typeof createVault>>,
  token: string,
  options: DeviceOptions = {},
) {
  const storage: SqliteAdapter = openSqliteAdapter(
    join(tempDir(`devot-sync-files-${name}-`), 'db.sqlite'),
  )
  cleanups.push(() => storage.close())
  const clock = createClock(name)
  const newId = createIdGenerator()
  const notes: NoteService = createNoteService({
    storage,
    clock,
    newId,
    saveDelayMs: 5,
  })
  const transport = new RelayTransport({
    url: () => relay.host.url,
    vault: vault.vault,
    token: () => token,
    ...options.transport,
  })
  const engine = createSyncEngine({
    storage,
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
  })
  transport.onEvent = (event) => engine.received(event)
  engine.start()
  cleanups.push(() => engine.stop())
  await engine.idle()
  const self = {
    name,
    storage,
    notes,
    engine,
    transport,
    newId,
    clock,
    async sync() {
      await notes.flush()
      await engine.syncNow()
      await notes.mergeStored()
    },
    /** A note that shows these attachments. */
    async noteWith(title: string, ...files: { id: string; data: Uint8Array }[]) {
      const id = await notes.create(title)
      for (const file of files) {
        await storage.putFile(
          { id: file.id, noteId: id, name: `${file.id.slice(-4)}.png` },
          file.data,
        )
      }
      await notes.setBody(id, files.map((f) => `![shot](devot://file/${f.id})\n`).join(''))
      await notes.flush()
      return id
    },
    file: (id: string) => storage.syncRead([id]).then(([row]) => row),
    bytes: (id: string) => storage.syncFileData(id),
  }
  return self
}

async function pair(options: { a?: DeviceOptions; b?: DeviceOptions; quota?: Quota | null } = {}) {
  const relay = await startRelay(options.quota === undefined ? { ...ROOMY } : options.quota)
  const vault = await createVault(relay.host, 'mac')
  const phone = await enrolled(relay.host, vault, 'phone')
  const a = await device('mac', relay, vault, vault.first.token, options.a)
  const b = await device('phone', relay, vault, phone.token, options.b)
  return { relay, vault, a, b }
}

async function settle(...devices: Device[]) {
  for (let round = 0; round < 2; round += 1) for (const d of devices) await d.sync()
}

const usage = async (d: Device) => {
  const reply = await d.transport.send({ type: 'usage' })
  return {
    stored: Number(reply['storedBytes']),
    files: Number(reply['fileBytes']),
  }
}

const FILE_1 = '0192a6f0-0000-7000-8000-00000000f001'
const FILE_2 = '0192a6f0-0000-7000-8000-00000000f002'
const FILE_3 = '0192a6f0-0000-7000-8000-00000000f003'

describe('an image added on one device', () => {
  it('appears on another, byte for byte, and is sent before the note that shows it', async () => {
    const { a, b } = await pair()
    const data = image(3 * KB)
    const note = await a.noteWith('Holiday', { id: FILE_1, data })
    await settle(a, b)
    expect(await b.bytes(FILE_1)).toEqual(data)
    expect(await b.file(FILE_1)).toMatchObject({
      file: {
        id: FILE_1,
        noteId: note,
        name: 'f001.png',
        mime: 'image/png',
        size: data.length,
      },
    })
    expect((await b.storage.getNote(note))?.bodyMd).toContain(`devot://file/${FILE_1}`)
    expect(a.transport.pushed.indexOf(FILE_1)).toBeGreaterThanOrEqual(0)
    expect(a.transport.pushed.indexOf(FILE_1)).toBeLessThan(a.transport.pushed.indexOf(note))
    expect(a.engine.status().unsyncedFiles).toBeNull()
  })

  it('sends the image first even when the note is older than the image', async () => {
    const { a, b } = await pair()
    const note = await a.notes.create('Early')
    await a.sync()
    await a.storage.putFile({ id: FILE_1, noteId: note, name: 'late.png' }, image(2 * KB))
    await a.notes.setBody(note, `![x](devot://file/${FILE_1})\n`)
    await a.notes.flush()
    const before = a.transport.pushed.length
    await a.engine.syncNow()
    const order = a.transport.pushed.slice(before)
    expect(order.indexOf(FILE_1)).toBeLessThan(order.indexOf(note))
    await settle(a, b)
    expect(await b.bytes(FILE_1)).toEqual(image(2 * KB))
  })

  it('sends a 10 MiB image as six chunks and the other device opens it whole', async () => {
    const { a, b } = await pair()
    const data = image(10 * 1024 * 1024)
    await a.noteWith('Big', { id: FILE_1, data })
    await a.sync()
    expect((await usage(a)).files).toBeGreaterThan(data.length)
    const pulled = await b.transport.pull(0)
    const head = pulled.records.find((r) => r.id === FILE_1)
    expect(head?.kind).toBe('file')
    await b.sync()
    const got = await b.bytes(FILE_1)
    expect(got?.length).toBe(data.length)
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true)
  }, 60_000)

  it('is not sent again once the other device holds it', async () => {
    const { a, b } = await pair()
    await a.noteWith('Once', { id: FILE_1, data: image(2 * KB) })
    await settle(a, b)
    const pushes = a.transport.pushes + b.transport.pushes
    await settle(a, b)
    expect(a.transport.pushes + b.transport.pushes).toBe(pushes)
  })
})

describe('the note an image belongs to', () => {
  it('goes to the higher HLC when two devices pass the image to different notes', async () => {
    const { a, b } = await pair()
    const first = await a.noteWith('First', {
      id: FILE_1,
      data: image(2 * KB),
    })
    const second = await a.notes.create('Second')
    const third = await a.notes.create('Third')
    await settle(a, b)
    const pass = (d: Device, to: string, hlc: string) => {
      d.storage.db
        .prepare('UPDATE files SET note_id = ?, note_hlc = ? WHERE id = ?')
        .run(to, hlc, FILE_1)
    }
    pass(a, second, '0001790000000001-0000-mac')
    pass(b, third, '0001790000000002-0000-phone')
    await settle(a, b)
    for (const d of [a, b]) {
      expect((await d.file(FILE_1))?.file).toMatchObject({
        noteId: third,
        noteHlc: '0001790000000002-0000-phone',
      })
    }
    expect(first).not.toBe(third)
  })

  it('moves to the note that still shows the image when its note is purged on one device', async () => {
    const { a, b } = await pair()
    const owner = await a.noteWith('Owner', {
      id: FILE_1,
      data: image(2 * KB),
    })
    const heir = await a.notes.create('Heir')
    await a.notes.setBody(heir, `![copy](devot://file/${FILE_1})\n`)
    await settle(a, b)
    await a.notes.trash(owner)
    await a.notes.purge(owner)
    await settle(a, b)
    for (const d of [a, b]) {
      const row = await d.file(FILE_1)
      expect(row?.file?.noteId).toBe(heir)
      expect(row?.file?.noteHlc).not.toBe('')
      expect(await d.bytes(FILE_1)).toEqual(image(2 * KB))
    }
  })

  it('keeps the image when the purge reaches a device before the heir note and the image sorts after the purged note', async () => {
    const { a, b } = await pair()
    const late = 'ffffffff-0000-7000-8000-00000000f001'
    const owner = await a.noteWith('Owner', { id: late, data: image(2 * KB) })
    await settle(a, b)
    const heir = await a.notes.create('Heir')
    await a.notes.setBody(heir, `![copy](devot://file/${late})\n`)
    await a.notes.flush()
    await a.notes.trash(owner)
    await a.notes.purge(owner)
    await settle(a, b)
    for (const d of [a, b]) {
      expect((await d.file(late))?.file?.noteId).toBe(heir)
      expect(await d.bytes(late)).toEqual(image(2 * KB))
    }
  })
})

describe('purging an image', () => {
  it('frees its bytes on the relay and removes the file on the other devices, for good', async () => {
    const { a, b } = await pair()
    const note = await a.noteWith(
      'Gone',
      { id: FILE_1, data: image(50 * KB) },
      { id: FILE_2, data: image(50 * KB, 2) },
    )
    await settle(a, b)
    expect((await usage(a)).files).toBeGreaterThan(100 * KB)
    expect(await b.bytes(FILE_1)).not.toBeNull()
    await a.notes.trash(note)
    await a.notes.purge(note)
    await settle(a, b)
    const after = await usage(a)
    expect(after.files).toBeLessThan(2 * KB)
    expect(after.stored).toBeLessThan(5 * KB)
    for (const id of [FILE_1, FILE_2]) {
      expect(await b.bytes(id)).toBeNull()
      expect((await b.file(id))?.entry).toMatchObject({ kind: 'file' })
      expect((await b.file(id))?.file).toBeNull()
    }
    // The tombstone stays: a device that comes back later learns of the purge, and nothing resurrects it.
    await settle(b, a)
    expect(await a.bytes(FILE_1)).toBeNull()
    const pulled = await a.transport.pull(0)
    const record = pulled.records.find((r) => r.id === FILE_1)
    expect(decodeRecord(FILE_1, record!.plaintext!)).toEqual(tombstoneFile(FILE_1))
  })

  it('leaves a device that was offline with no image once it comes back', async () => {
    const { a, b } = await pair()
    const note = await a.noteWith('Offline', {
      id: FILE_1,
      data: image(2 * KB),
    })
    await settle(a, b)
    await a.notes.trash(note)
    await a.notes.purge(note)
    await a.sync()
    await b.sync()
    expect(await b.bytes(FILE_1)).toBeNull()
  })
})

describe('what is refused', () => {
  const tampered = (
    change: (plaintext: Uint8Array) => Uint8Array,
  ): Partial<RelayTransportOptions> => ({
    tamper: (record) =>
      record.kind === 'file' && record.plaintext
        ? { ...record, plaintext: change(record.plaintext) }
        : record,
  })

  it('leaves out a record whose bytes are not an image, and logs it by code and ID', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")
    const { a, b } = await pair({
      b: {
        transport: tampered((plaintext) => {
          const record = decodeRecord(FILE_1, plaintext)
          if (record.kind !== 'file') return plaintext
          return encodeRecord({
            ...record,
            mime: 'image/svg+xml',
            size: svg.length,
            data: svg,
          })
        }),
      },
    })
    const note = await a.noteWith('Tampered', {
      id: FILE_1,
      data: image(2 * KB),
    })
    await settle(a, b)
    expect(await b.bytes(FILE_1)).toBeNull()
    expect((await b.storage.getNote(note))?.title).toBe('Tampered')
    expect(warn).toHaveBeenCalledWith('W_SYNC_RECORD_SKIPPED', FILE_1, 'E_SYNC_RECORD_INVALID')
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).not.toContain('svg')
  })

  it('leaves out a record that claims a size it does not have, and one past 10 MiB', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const change of [
      (plaintext: Uint8Array) => plaintext.subarray(0, plaintext.length - 7),
      (plaintext: Uint8Array) => {
        const record = decodeRecord(FILE_1, plaintext)
        if (record.kind !== 'file') return plaintext
        const big = image(10 * 1024 * 1024 + 1)
        return encodeRecord({ ...record, size: big.length, data: big })
      },
    ]) {
      const { a, b } = await pair({
        b: { transport: tampered(change) },
      })
      await a.noteWith('Odd', { id: FILE_1, data: image(2 * KB) })
      await settle(a, b)
      expect(await b.bytes(FILE_1)).toBeNull()
    }
    expect(warn.mock.calls.filter((c) => c[0] === 'W_SYNC_RECORD_SKIPPED').length).toBeGreaterThan(
      1,
    )
  }, 30_000)

  it('leaves out a file record the relay passes off as another kind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { a, b } = await pair({
      b: {
        transport: {
          tamper: (record) => (record.kind === 'file' ? { ...record, kind: 'record' } : record),
        },
      },
    })
    await a.noteWith('Mislabelled', { id: FILE_1, data: image(2 * KB) })
    await settle(a, b)
    expect(await b.bytes(FILE_1)).toBeNull()
    expect(warn).toHaveBeenCalledWith('W_SYNC_RECORD_SKIPPED', FILE_1, 'E_SYNC_RECORD_KIND')
  })
})

describe('an upload that is interrupted', () => {
  it('resumes when the connection drops before the relay got the image', async () => {
    let cut = true
    const { a, b } = await pair({
      a: {
        transport: {
          cut: (id, kind) => (kind === 'file' && cut ? 'before' : undefined),
        },
      },
    })
    const data = image(30 * KB)
    const note = await a.noteWith('Resume', { id: FILE_1, data })
    await a.notes.flush()
    await a.engine.syncNow()
    await a.engine.idle()
    expect(a.engine.status().state).toBe('offline')
    expect((await usage(b)).files).toBe(0)
    expect(await a.storage.syncPendingCount()).toBeGreaterThan(0)
    cut = false
    await a.engine.syncNow()
    await settle(b, a)
    expect(a.engine.status()).toMatchObject({
      state: 'idle',
      unsyncedFiles: null,
    })
    expect(await b.bytes(FILE_1)).toEqual(data)
    expect((await b.storage.getNote(note))?.title).toBe('Resume')
  })

  it('resumes when the relay took the image and the answer was lost, without storing it twice', async () => {
    let cut = true
    const { a, b } = await pair({
      a: {
        transport: {
          cut: (id, kind) => (kind === 'file' && cut ? 'after' : undefined),
        },
      },
    })
    const data = image(30 * KB)
    await a.noteWith('Lost answer', { id: FILE_1, data })
    await a.notes.flush()
    await a.engine.syncNow()
    await a.engine.idle()
    expect(a.engine.status().state).toBe('offline')
    await vi.waitFor(async () => expect((await usage(b)).files).toBeGreaterThan(30 * KB))
    const stored = await usage(b)
    cut = false
    await a.engine.syncNow()
    await settle(b, a)
    expect((await usage(b)).files).toBe(stored.files)
    expect(a.engine.status()).toMatchObject({
      state: 'idle',
      unsyncedFiles: null,
    })
    expect(await b.bytes(FILE_1)).toEqual(data)
    const [row] = await a.storage.syncRead([FILE_1])
    expect(row?.entry?.version).toBe(1)
  })
})

describe('the attachment share', () => {
  const limits = (fileBytes: number): Quota => ({ ...ROOMY, fileBytes })

  it('keeps an image that does not fit on its device while notes keep syncing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { a, b } = await pair({ quota: limits(120 * KB) })
    const one = await a.noteWith('One', { id: FILE_1, data: image(50 * KB) })
    const two = await a.noteWith('Two', {
      id: FILE_2,
      data: image(50 * KB, 2),
    })
    const three = await a.noteWith('Three', {
      id: FILE_3,
      data: image(50 * KB, 3),
    })
    await settle(a, b)
    expect(a.engine.status()).toMatchObject({
      state: 'idle',
      code: null,
      unsyncedFiles: { count: 1, code: 'E_SYNC_ATTACHMENTS_FULL' },
    })
    expect(warn).toHaveBeenCalledWith('W_SYNC_ATTACHMENTS_FULL', FILE_3)
    expect(await b.bytes(FILE_1)).not.toBeNull()
    expect(await b.bytes(FILE_2)).not.toBeNull()
    expect(await b.bytes(FILE_3)).toBeNull()
    expect(await a.bytes(FILE_3)).not.toBeNull()
    for (const id of [one, two, three]) expect((await b.storage.getNote(id))?.id).toBe(id)
    const note = await a.notes.create('After')
    await a.notes.setBody(note, 'still syncing\n')
    await settle(a, b)
    expect((await b.storage.getNote(note))?.bodyMd).toBe('still syncing\n')
    expect(a.engine.status().unsyncedFiles?.count).toBe(1)
  })

  it('sends the image that did not fit once a purge frees room, without a restart', async () => {
    const { a, b } = await pair({ quota: limits(120 * KB) })
    const one = await a.noteWith('One', { id: FILE_1, data: image(50 * KB) })
    await a.noteWith('Two', { id: FILE_2, data: image(50 * KB, 2) })
    await a.noteWith('Three', { id: FILE_3, data: image(50 * KB, 3) })
    await settle(a, b)
    expect(a.engine.status().unsyncedFiles?.count).toBe(1)
    await a.notes.trash(one)
    await a.notes.purge(one)
    await settle(a, b)
    expect(a.engine.status().unsyncedFiles).toBeNull()
    expect(await b.bytes(FILE_3)).toEqual(image(50 * KB, 3))
    expect(await b.bytes(FILE_1)).toBeNull()
  })

  it('tries again on the next launch', async () => {
    const quota = limits(60 * KB)
    const { a, b } = await pair({ quota })
    await a.noteWith('One', { id: FILE_1, data: image(50 * KB) })
    await a.noteWith('Two', { id: FILE_2, data: image(50 * KB, 2) })
    await settle(a, b)
    expect(a.engine.status().unsyncedFiles?.count).toBe(1)
    quota.fileBytes = 3e9
    await a.engine.stop()
    a.engine.start()
    await a.engine.idle()
    await settle(a, b)
    expect(a.engine.status().unsyncedFiles).toBeNull()
    expect(await b.bytes(FILE_2)).not.toBeNull()
  })

  it('does not send a larger image once a smaller one was refused, until room is made', async () => {
    const { a, b } = await pair({ quota: limits(60 * KB) })
    await a.noteWith('Fits', { id: FILE_1, data: image(50 * KB) })
    await a.noteWith('Small', { id: FILE_2, data: image(20 * KB, 2) })
    await a.noteWith('Large', { id: FILE_3, data: image(70 * KB, 3) })
    await settle(a, b)
    expect(a.engine.status().unsyncedFiles).toEqual({
      count: 2,
      code: 'E_SYNC_ATTACHMENTS_FULL',
    })
    const sent = a.transport.pushed.filter((id) => id === FILE_3).length
    // FILE_3 is bigger than FILE_2, which the relay already refused: only FILE_2 went out and came back.
    expect(sent).toBe(0)
  })

  it('goes on to a purge after a note whose image the relay’s storage refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const quota = { ...ROOMY }
    // Only the explicit sync below pushes, so the pass that meets the refused image is the one checked.
    const { a, b } = await pair({
      quota,
      a: { engine: { idleMs: 60_000, everyMs: 60_000 } },
    })
    // Sorts after the notes, so the note meets the image before the pass reaches it.
    const late = 'ffffffff-0000-7000-8000-00000000f001'
    const shows = await a.notes.create('Shows')
    const gone = await a.notes.create('Gone')
    await a.notes.setBody(gone, 'y'.repeat(2000))
    await settle(a, b)
    quota.storedBytes = 1
    await a.storage.putFile({ id: late, noteId: shows, name: 'one.png' }, image(10 * KB))
    await a.notes.setBody(shows, `![shot](devot://file/${late})\n`)
    await a.notes.trash(gone)
    await a.notes.purge(gone)
    await a.sync()
    await a.engine.idle()
    expect(a.engine.status()).toMatchObject({
      state: 'paused',
      code: 'E_SYNC_STORAGE_FULL',
      unsyncedFiles: { count: 1, code: 'E_SYNC_ATTACHMENTS_FULL' },
    })
    await b.sync()
    expect((await b.storage.syncRead([gone]))[0]?.note?.purged).toBe(true)
    expect(await b.bytes(late)).toBeNull()
  })

  it('does not pause sync, and the daily quota still does', async () => {
    const time = { now: Date.UTC(2026, 9, 23, 12) }
    const relay = await startRelay(
      { ...ROOMY, fileBytes: 10 * KB, rowsWritten: 14 },
      () => time.now,
    )
    const vault = await createVault(relay.host, 'mac')
    const a = await device('mac', relay, vault, vault.first.token, {
      now: () => time.now,
    })
    await a.noteWith('Image', { id: FILE_1, data: image(50 * KB) })
    await a.sync()
    expect(a.engine.status()).toMatchObject({
      state: 'idle',
      unsyncedFiles: { count: 1, code: 'E_SYNC_ATTACHMENTS_FULL' },
    })
    for (let i = 0; i < 8; i++) await a.notes.create(`Note ${i}`)
    await a.sync()
    await a.engine.idle()
    expect(a.engine.status()).toMatchObject({
      state: 'paused',
      code: 'E_SYNC_QUOTA',
    })
    // The share is not what paused it, and the image is still counted as local only.
    expect(a.engine.status().unsyncedFiles?.count).toBe(1)
  })
})

describe('a relay from before attachments', () => {
  it('keeps images on the device and says to update, while notes sync', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { a, b } = await pair({
      a: {
        transport: {
          beforePush: async (_id, kind) => {
            if (kind === 'file') throw new Error('E_SYNC_BAD_MESSAGE')
          },
          welcome: (welcome) => {
            const { attachments: _a, ...older } = welcome
            return older
          },
        },
      },
    })
    const note = await a.noteWith('Older relay', {
      id: FILE_1,
      data: image(2 * KB),
    })
    await settle(a, b)
    expect(a.engine.status()).toMatchObject({
      state: 'idle',
      relayOutdated: true,
      unsyncedFiles: { count: 1, code: 'E_SYNC_RELAY_OUTDATED' },
    })
    expect(warn).toHaveBeenCalledWith('W_SYNC_RELAY_FILES_UNSUPPORTED', FILE_1)
    expect((await b.storage.getNote(note))?.title).toBe('Older relay')
    expect(await b.bytes(FILE_1)).toBeNull()
    expect(await a.bytes(FILE_1)).toEqual(image(2 * KB))
    expect((await a.storage.syncRead([FILE_1]))[0]?.entry).toMatchObject({
      version: 0,
    })
  })

  it('sends no image to a relay that does not say it holds them, and sends them once it is updated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let older = true
    const { a, b } = await pair({
      a: {
        transport: {
          welcome: (welcome) => {
            if (!older) return welcome
            const { attachments: _a, ...before } = welcome
            return before
          },
        },
      },
    })
    const note = await a.noteWith('No share', {
      id: FILE_1,
      data: image(2 * KB),
    })
    await settle(a, b)
    expect(a.engine.status()).toMatchObject({
      state: 'idle',
      relayOutdated: true,
      unsyncedFiles: { count: 1, code: 'E_SYNC_RELAY_OUTDATED' },
    })
    expect(warn).toHaveBeenCalledWith('W_SYNC_RELAY_FILES_UNSUPPORTED', FILE_1)
    expect((await b.storage.getNote(note))?.title).toBe('No share')
    expect(await b.bytes(FILE_1)).toBeNull()

    older = false
    await a.engine.stop()
    a.engine.start()
    await settle(a, b)
    expect(a.engine.status()).toMatchObject({
      relayOutdated: false,
      unsyncedFiles: null,
    })
    expect(await b.bytes(FILE_1)).toEqual(image(2 * KB))
  })

  it('stays current with a relay that says attachments are on', async () => {
    const { a, b } = await pair()
    await a.sync()
    await b.sync()
    expect(a.engine.status().relayOutdated).toBe(false)
  })
})
