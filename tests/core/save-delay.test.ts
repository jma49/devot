// A note saves a short while after typing pauses, longer for a large one (each save encodes its
// whole state), and a flush (quitting, opening another note) saves it at once whatever its size.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService, saveDelay } from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const KB = 1024
const MB = 1024 * KB

describe('saveDelay', () => {
  it('waits the base delay below 64 KB and grows to 2 s for 300 ms at 1 MB and beyond', () => {
    expect(saveDelay(300, 0)).toBe(300)
    expect(saveDelay(300, 64 * KB)).toBe(300)
    expect(saveDelay(300, 1 * MB)).toBe(2_000)
    expect(saveDelay(300, 40 * MB)).toBe(2_000)
    const between = saveDelay(300, 512 * KB)
    expect(between).toBeGreaterThan(300)
    expect(between).toBeLessThan(2_000)
    expect(saveDelay(300, 600 * KB)).toBeGreaterThan(between)
    expect(saveDelay(30, 1 * MB)).toBe(200)
  })
})

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const service = (storage: SqliteAdapter, saveDelayMs = 30) =>
  createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    saveDelayMs,
  })

describe('saving a large note', () => {
  it('waits longer after a pause, and a flush still saves it at once', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-save-delay-'), 'devot.sqlite'))
    open.push(storage)
    const notes = service(storage)
    const id = await notes.create('Big')
    await notes.setBody(id, 'x'.repeat(MB + KB))
    await notes.flush()

    await notes.setBody(id, 'edited')
    // A small note would be saved by now; this one waits about 200 ms.
    await sleep(90)
    expect((await storage.getNote(id))?.bodyMd).not.toBe('edited')
    await notes.flush()
    expect((await storage.getNote(id))?.bodyMd).toBe('edited')
  })

  it('waits as long for a large note read from storage', async () => {
    const path = join(tempDir('devot-save-delay-'), 'devot.sqlite')
    const writer = openSqliteAdapter(path)
    open.push(writer)
    const before = service(writer)
    const id = await before.create('Big')
    await before.setBody(id, 'x'.repeat(MB + KB))
    await before.flush()

    const storage = openSqliteAdapter(path)
    open.push(storage)
    const notes = service(storage, 300)
    await notes.setBody(id, 'edited')
    // A small note would be saved by now; this one waits about 2 s.
    await sleep(600)
    expect((await storage.getNote(id))?.bodyMd).not.toBe('edited')
    await notes.flush()
    expect((await storage.getNote(id))?.bodyMd).toBe('edited')
  })
})
