// A backup restored on one device while sync was off, then sync turned on again (#515): the
// engine waits for the person to choose. Merge brings the other devices' later changes back; Keep
// gives every restored record fresh clocks, so the restored notes win everywhere.
import { copyFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
} from '../../src/core'
import { createSyncEngine } from '../../src/core/sync/engine'
import { RESTORE_CHOICE, RESTORED_AT } from '../../src/core/sync/restore'
import { startNodeRelay } from '../../relay/src/node/server'
import { createVault, enrolled, type RelayHost, type TestVault } from '../relay/client'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { RelayTransport } from '../support/sync-relay'
import { tempDir } from '../support/temp-dirs'

const SECRET = 'test-relay-secret-0123456789abcdef'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Device = ReturnType<typeof device>

function device(name: string, host: RelayHost, vault: TestVault, token: string) {
  const path = join(tempDir(`devot-restore-${name}-`), 'db.sqlite')
  const clock = createClock(name)
  const newId = createIdGenerator()
  const transport = new RelayTransport({
    url: () => host.url,
    vault: vault.vault,
    token: () => token,
  })
  const open = () => {
    const storage: SqliteAdapter = openSqliteAdapter(path)
    const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
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
    })
    transport.onEvent = (event) => engine.received(event)
    engine.start()
    const parts = {
      storage,
      notes,
      engine,
      books: createBookService({ storage, clock, newId }),
      tags: createTagService({ storage, clock, newId }),
    }
    const close = async () => {
      await engine.stop()
      storage.close()
    }
    cleanups.push(close)
    return { ...parts, close }
  }
  const self = {
    path,
    live: open(),
    async sync() {
      await self.live.notes.flush()
      await self.live.engine.syncNow()
      await self.live.notes.mergeStored()
    },
    note: (id: string) => self.live.storage.getNote(id, { trashed: true }),
    /** As Backups::restore does with sync off: the backup's pages over the database, and the marker. */
    async restore(backup: string) {
      await self.live.close()
      cleanups.splice(cleanups.indexOf(self.live.close), 1)
      for (const side of ['-wal', '-shm']) rmSync(`${path}${side}`, { force: true })
      copyFileSync(backup, path)
      self.live = open()
      await self.live.storage.syncSetState(RESTORED_AT, String(Date.now()))
      await self.live.engine.idle()
    },
  }
  return self
}

async function pair() {
  const data = tempDir('devot-restore-relay-')
  const node = await startNodeRelay({ data, secret: SECRET })
  cleanups.push(() => node.close())
  const host = { ...node, secret: SECRET }
  const vault = await createVault(host, 'mac')
  const phone = await enrolled(host, vault, 'phone')
  const a = device('mac', host, vault, vault.first.token)
  const b = device('phone', host, vault, phone.token)
  await a.live.engine.idle()
  await b.live.engine.idle()
  return { a, b }
}

async function settle(...devices: Device[]) {
  for (let round = 0; round < 2; round += 1) for (const d of devices) await d.sync()
}

/** A backup on `a`, then a later edit everywhere, then the backup restored on `a`. */
async function restoredAfterAnEdit() {
  const { a, b } = await pair()
  const id = await a.live.notes.create('Plan')
  await a.live.notes.setBody(id, 'Monday\n')
  const book = await a.live.books.create('Work', null)
  await settle(a, b)
  const backup = join(tempDir('devot-restore-backup-'), 'backup.sqlite')
  await a.live.notes.flush()
  await a.live.storage.db.backup(backup)
  await b.live.notes.setBody(id, 'Monday\nTuesday\n')
  await b.live.notes.setTitle(id, 'Plan for the week')
  await b.live.books.rename(book, 'Office')
  await settle(b, a)
  expect((await a.note(id))?.bodyMd).toBe('Monday\nTuesday\n')
  await a.restore(backup)
  return { a, b, id, book }
}

describe('turning sync on after a backup was restored', () => {
  it('waits for a choice, without pulling or pushing', async () => {
    const { a, id } = await restoredAfterAnEdit()
    expect(a.live.engine.status()).toMatchObject({ state: 'stopped', code: RESTORE_CHOICE })
    await a.sync()
    expect((await a.note(id))?.bodyMd).toBe('Monday\n')
    expect(a.live.engine.status().code).toBe(RESTORE_CHOICE)
  })

  it('keeps this device’s restored notes everywhere when asked to', async () => {
    const { a, b, id, book } = await restoredAfterAnEdit()
    await a.live.engine.afterRestore('keep')
    await settle(a, b)
    for (const d of [a, b]) {
      expect(await d.note(id)).toMatchObject({ title: 'Plan', bodyMd: 'Monday\n' })
      expect((await d.live.storage.listBooks()).find((x) => x.id === book)?.name).toBe('Work')
    }
    expect((await a.live.storage.syncState())[RESTORED_AT] ?? '').toBe('')
    expect(a.live.engine.status()).toMatchObject({ state: 'idle', code: null })
    // Later edits sync as before.
    await b.live.notes.setBody(id, 'Monday\nWednesday\n')
    await settle(b, a)
    expect((await a.note(id))?.bodyMd).toBe('Monday\nWednesday\n')
  })

  it('brings the later changes back when asked to merge', async () => {
    const { a, b, id, book } = await restoredAfterAnEdit()
    await a.live.engine.afterRestore('merge')
    await settle(a, b)
    for (const d of [a, b]) {
      expect(await d.note(id)).toMatchObject({
        title: 'Plan for the week',
        bodyMd: 'Monday\nTuesday\n',
      })
      expect((await d.live.storage.listBooks()).find((x) => x.id === book)?.name).toBe('Office')
    }
    expect((await a.live.storage.syncState())[RESTORED_AT] ?? '').toBe('')
  })

  it('asks nothing when the restored library had never synced', async () => {
    const { a } = await pair()
    await a.live.storage.syncSetState('since', '0')
    const backup = join(tempDir('devot-restore-backup-'), 'backup.sqlite')
    await a.live.storage.db.backup(backup)
    await a.restore(backup)
    await a.sync()
    expect(a.live.engine.status()).toMatchObject({ state: 'idle', code: null })
  })

  it('reads the marker under the key Rust writes it with', () => {
    const rust = readFileSync('src-tauri/src/backups.rs', 'utf8')
    expect(rust).toContain(`const RESTORED_AT: &str = "${RESTORED_AT}";`)
  })
})
