// The UI tests' storage reads one note by its ID without parsing every note each time; it must still see each write,
// including one a test makes in localStorage directly.
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { NoteRecord, StorageAdapter } from '../../src/core'
import { restoreLocalStorage, useMemoryLocalStorage } from '../support/local-storage'

afterAll(restoreLocalStorage)

const id = (n: number) => `0192a6f0-0000-7000-8000-${String(n).padStart(12, '0')}`
const HLC = '0001728000000000-0000-node'

function record(n: number, change: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: id(n),
    title: `Note ${n}`,
    titleHlc: HLC,
    bodyMd: `Body ${n}`,
    ydoc: Uint8Array.of(0, 0),
    bodyVersion: 0,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: n,
    updatedAt: n,
    deletedAt: null,
    deletedHlc: null,
    ...change,
  }
}

const stored = (note: NoteRecord) => ({ ...note, ydoc: [...note.ydoc] })

let storage: StorageAdapter

beforeEach(async () => {
  useMemoryLocalStorage()
  storage = (await import('../../src/renderer/src/storage/memory')).memoryStorage
})

describe('memory storage note reads', () => {
  it('sees a write made through the adapter after an earlier read', async () => {
    await storage.putNote(record(1))
    expect((await storage.getNote(id(1)))?.bodyMd).toBe('Body 1')
    await storage.putNote(record(1, { bodyMd: 'Changed', bodyVersion: 1 }))
    expect((await storage.getNote(id(1)))?.bodyMd).toBe('Changed')
    expect(await storage.getNote(id(2))).toBeNull()
  })

  it('sees notes a test puts in localStorage directly', async () => {
    localStorage.setItem('devot.test.notes', JSON.stringify([stored(record(1))]))
    expect((await storage.getNote(id(1)))?.title).toBe('Note 1')
    localStorage.setItem(
      'devot.test.notes',
      JSON.stringify([stored(record(1, { title: 'Renamed' })), stored(record(2))]),
    )
    expect((await storage.getNote(id(1)))?.title).toBe('Renamed')
    expect((await storage.getNote(id(2)))?.title).toBe('Note 2')
  })

  it('reads a trashed note only when asked to, and a purged one never', async () => {
    await storage.putNote(record(1, { deletedAt: 5, deletedHlc: HLC }))
    expect(await storage.getNote(id(1))).toBeNull()
    expect((await storage.getNote(id(1), { trashed: true }))?.id).toBe(id(1))
    await storage.purgeNote(id(1), 6, '0001728000000009-0000-node')
    expect(await storage.getNote(id(1), { trashed: true })).toBeNull()
  })

  it('hands out a copy: changing a read record changes no later read', async () => {
    await storage.putNote(record(1))
    const first = await storage.getNote(id(1))
    first!.title = 'Changed'
    first!.ydoc[0] = 9
    const again = await storage.getNote(id(1))
    expect(again?.title).toBe('Note 1')
    expect(again?.ydoc[0]).toBe(0)
  })

  it('purges a batch together and restores it if any note is live', async () => {
    await storage.putNote(record(1, { deletedAt: 5, deletedHlc: HLC }))
    await storage.putNote(record(2))
    await expect(storage.purgeNotes([id(1), id(2)], 6, HLC)).rejects.toThrow('E_NOTE_NOT_TRASHED')
    expect((await storage.getNote(id(1), { trashed: true }))?.bodyMd).toBe('Body 1')
    await storage.putNote(record(2, { deletedAt: 5, deletedHlc: HLC, bodyVersion: 1 }))
    await storage.purgeNotes([id(1), id(2)], 6, HLC)
    expect(await storage.listTrash()).toEqual([])
    await storage.purgeNotes([], 7, HLC)
  })

  it('stores an attachment past 128 KB without overflowing the call stack', async () => {
    await storage.putNote(record(1))
    const png = new Uint8Array(150_000)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await storage.putFile({ id: id(10), noteId: id(1), name: 'large.png' }, png)
    const storedFiles = JSON.parse(localStorage.getItem('devot.test.files') ?? '[]') as {
      id: string
      base64: string
    }[]
    expect(storedFiles).toHaveLength(1)
    expect(storedFiles[0]?.id).toBe(id(10))
    expect(storedFiles[0]?.base64.length).toBe(200_000)
  })
})
