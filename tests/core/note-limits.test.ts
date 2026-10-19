// Every storage adapter refuses what the app's note_put refuses, with its
// codes, so the core and its tests see the same refusals as the app.
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  createIdGenerator,
  MAX_BODY_BYTES,
  MAX_BODY_VERSION,
  MAX_NOTE_LINKS,
  MAX_TITLE_CHARS,
  MAX_YDOC_BYTES,
  noteLink,
  type NoteRecord,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const ID = '0192a6f0-0000-7000-8000-000000000001'

function record(change: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id: ID,
    title: 'Title',
    titleHlc: '0001728000000000-0000-node',
    bodyMd: '',
    ydoc: Uint8Array.of(0, 0),
    bodyVersion: 0,
    bookId: null,
    bookHlc: '',
    status: 'none',
    statusHlc: '',
    pinned: false,
    pinnedHlc: '',
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    deletedHlc: null,
    ...change,
  }
}

const newId = createIdGenerator()
const links = (count: number) =>
  Array.from({ length: count }, () => noteLink('n', newId())).join('\n')

const CASES: [string, () => Partial<NoteRecord>, string | null][] = [
  ['a title of the most characters', () => ({ title: '\u{1F600}'.repeat(MAX_TITLE_CHARS) }), null],
  [
    'a title one character longer',
    () => ({ title: 'x'.repeat(MAX_TITLE_CHARS + 1) }),
    'E_NOTE_TITLE_INVALID',
  ],
  ['a title on two lines', () => ({ title: 'two\nlines' }), 'E_NOTE_TITLE_INVALID'],
  ['a title with a carriage return', () => ({ title: 'two\rlines' }), 'E_NOTE_TITLE_INVALID'],
  [
    'a body over the size, counted in UTF-8 bytes',
    () => ({ bodyMd: '\u00e9'.repeat(MAX_BODY_BYTES / 2 + 1) }),
    'E_NOTE_BODY_TOO_LARGE',
  ],
  [
    'a Yjs state over the size',
    () => ({ ydoc: new Uint8Array(MAX_YDOC_BYTES + 1) }),
    'E_NOTE_YDOC_INVALID',
  ],
  ['an empty Yjs state', () => ({ ydoc: new Uint8Array(0) }), 'E_NOTE_YDOC_INVALID'],
  ['as many links as a body may hold', () => ({ bodyMd: links(MAX_NOTE_LINKS) }), null],
  ['one link more', () => ({ bodyMd: links(MAX_NOTE_LINKS + 1) }), 'E_NOTE_LINKS_TOO_MANY'],
  ['a negative body version', () => ({ bodyVersion: -1 }), 'E_NOTE_VERSION_INVALID'],
  ['a body version that is not whole', () => ({ bodyVersion: 1.5 }), 'E_NOTE_VERSION_INVALID'],
  [
    'a body version storage could not move on exactly',
    () => ({ bodyVersion: MAX_BODY_VERSION }),
    'E_NOTE_VERSION_INVALID',
  ],
]

async function answers(storage: StorageAdapter) {
  const result: (string | null)[] = []
  let bodyVersion = 0
  for (const [, change] of CASES) {
    const answer = await storage.putNote(record({ bodyVersion, ...change() })).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    if (answer === null) bodyVersion += 1
    result.push(answer)
  }
  return result
}

const EXPECTED = CASES.map(([, , code]) => code)

describe('note writes over the limits', () => {
  it('are refused by the SQLite adapter, with note_put’s codes', async () => {
    const sqlite = openSqliteAdapter(join(tempDir('devot-limits-'), 'devot.sqlite'))
    open.push(sqlite)
    expect(await answers(sqlite)).toEqual(EXPECTED)
    expect((await sqlite.getNote(ID))?.title).toBe('\u{1F600}'.repeat(MAX_TITLE_CHARS))
  })

  describe('in the UI tests’ memory adapter', () => {
    // Node's own localStorage warns when read without a file; it is replaced
    // without reading it.
    const nodeLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    beforeAll(() => {
      const items = new Map<string, string>()
      const value = {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, text: string) => void items.set(key, text),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear(),
      }
      Object.defineProperty(globalThis, 'localStorage', {
        value,
        configurable: true,
        writable: true,
      })
    })
    afterAll(() => {
      if (nodeLocalStorage) Object.defineProperty(globalThis, 'localStorage', nodeLocalStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    })

    it('are refused the same way', async () => {
      const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
      expect(await answers(memoryStorage)).toEqual(EXPECTED)
    })

    it('fail on purpose while a UI test asks them to (a full disk, say)', async () => {
      const { memoryStorage } = await import('../../src/renderer/src/storage/memory')
      localStorage.setItem('devot.test.failNoteWrites', 'E_STORAGE_SQLITE')
      await expect(memoryStorage.putNote(record({ title: 'Failed' }))).rejects.toThrow(
        'E_STORAGE_SQLITE',
      )
      localStorage.removeItem('devot.test.failNoteWrites')
      const { bodyVersion } = (await memoryStorage.getNote(ID))!
      await memoryStorage.putNote(
        record({ title: 'Saved', titleHlc: '0001728000000009-0000-node', bodyVersion }),
      )
      expect((await memoryStorage.getNote(ID))?.title).toBe('Saved')
    })
  })

  describe('in the app’s adapter', () => {
    const sent: string[] = []
    beforeAll(() => {
      const ipc = { invoke: async (cmd: string) => void sent.push(cmd) }
      Object.defineProperty(globalThis, 'window', {
        value: { __TAURI_INTERNALS__: ipc },
        configurable: true,
        writable: true,
      })
    })
    afterAll(() => Reflect.deleteProperty(globalThis, 'window'))

    it('are refused the same way before they cross to Rust', async () => {
      const { tauriStorage } = await import('../../src/renderer/src/storage/tauri')
      expect(await answers(tauriStorage)).toEqual(EXPECTED)
      expect(sent).toEqual(EXPECTED.filter((code) => code === null).map(() => 'note_put'))
    })
  })
})
