// Yjs states cross between the core worker and the page as base64 coded in the worker, so a save or an open costs
// the UI thread no per-byte work (a long, much-edited note's state is several MiB).
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type NoteRecord, type RevisionRecord } from '../../src/core'
import { invoke } from '../../src/renderer/src/ipc'
import { tauriStorage, tauriWire } from '../../src/renderer/src/storage/tauri'
import {
  fromBase64,
  fromWire,
  toBase64,
  toWire,
  type WireNote,
  type WireStorage,
} from '../../src/renderer/src/storage/wire'
import { expectWithinBudget } from '../support/budget'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

vi.mock('../../src/renderer/src/ipc', () => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}))

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))
beforeEach(() => vi.mocked(invoke).mockClear())

const MIB = 1 << 20

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))
const fields = ({ ydoc, ...rest }: NoteRecord) => ({
  ...rest,
  ydoc: Buffer.from(ydoc).toString('base64'),
})

/** Not all alike, so nothing compresses. */
const bytes = (length: number) => {
  const out = new Uint8Array(length)
  let s = length + 1
  for (let i = 0; i < length; i += 1) out[i] = (s = (s * 1103515245 + 12345) % 2147483648) >>> 16
  return out
}

type NativeBase64 = { proto: { toBase64?: unknown }; ctor: { fromBase64?: unknown } }
const native = (): NativeBase64 => ({
  proto: Uint8Array.prototype as { toBase64?: unknown },
  ctor: Uint8Array as { fromBase64?: unknown },
})
const hasNativeBase64 = () => {
  const { proto, ctor } = native()
  return typeof proto.toBase64 === 'function' && typeof ctor.fromBase64 === 'function'
}
function withoutNativeBase64(run: () => void): void {
  const { proto, ctor } = native()
  const saved = { toBase64: proto.toBase64, fromBase64: ctor.fromBase64 }
  delete proto.toBase64
  delete ctor.fromBase64
  try {
    run()
  } finally {
    if (saved.toBase64) proto.toBase64 = saved.toBase64
    if (saved.fromBase64) ctor.fromBase64 = saved.fromBase64
  }
}

const note = (overrides: Partial<NoteRecord> = {}): NoteRecord => ({
  id: '0192a6f0-0000-7000-8000-000000000001',
  title: 'Plan',
  titleHlc: '0000000000001-0000-test',
  bodyMd: 'See [the other](devot://note/0192a6f0-0000-7000-8000-000000000002)',
  ydoc: bytes(300),
  bodyVersion: 0,
  bookId: null,
  bookHlc: '',
  status: 'none',
  statusHlc: '',
  pinned: false,
  pinnedHlc: '',
  datesHlc: '',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  deletedHlc: null,
  ...overrides,
})

describe('base64 for Yjs states', () => {
  const sizes = [0, 1, 2, 3, 4, 0x8000, 0x8001, MIB + 1]

  it('codes any bytes as the Tauri commands read them', () => {
    for (const size of sizes) {
      const data = bytes(size)
      const text = toBase64(data)
      expect(text).toBe(Buffer.from(data).toString('base64'))
      expect(same(fromBase64(text), data)).toBe(true)
    }
  })

  it('codes a 1 MiB state in the worker in well under a frame', (context) => {
    // Engines before V8 14 (Node 24) have no coder of their own; the next
    // test times the fallback they run instead.
    if (!hasNativeBase64()) context.skip('engine has no base64 of its own')
    const data = bytes(MIB)
    const start = performance.now()
    for (let i = 0; i < 10; i += 1) fromBase64(toBase64(data))
    // Ten saves and opens; the byte loop this replaced took about 11 ms for one.
    expectWithinBudget(context, performance.now() - start, 40)
  })

  it('codes a 1 MiB state quickly without the engine’s own base64', (context) => {
    const data = bytes(MIB)
    withoutNativeBase64(() => {
      const start = performance.now()
      for (let i = 0; i < 10; i += 1) fromBase64(toBase64(data))
      // Ten saves and opens: about 35 ms on Node 24; the spread-and-btoa
      // loop the fallback replaced took about 250 ms.
      expectWithinBudget(context, performance.now() - start, 120)
    })
  })

  it('codes the same without the engine’s own base64', () => {
    withoutNativeBase64(() => {
      for (const size of sizes) {
        const data = bytes(size)
        const text = toBase64(data)
        expect(text).toBe(Buffer.from(data).toString('base64'))
        expect(same(fromBase64(text), data)).toBe(true)
      }
    })
  })
})

describe('the worker’s side', () => {
  function stores() {
    const sqlite = openSqliteAdapter(join(tempDir('devot-wire-'), 'devot.sqlite'))
    open.push(sqlite)
    const wire = toWire(sqlite)
    const puts: { note: WireNote; links: string[] }[] = []
    const watched: WireStorage = {
      ...wire,
      async putNote(record, links) {
        puts.push({ note: record, links })
        await wire.putNote(record, links)
      },
    }
    return { sqlite, puts, storage: fromWire(watched) }
  }

  it('codes states, finds the links and checks the limits before anything crosses', async () => {
    const { sqlite, puts, storage } = stores()
    const record = note({ ydoc: bytes(MIB) })
    await storage.putNote(record)
    expect(puts).toHaveLength(1)
    expect(puts[0]?.note.ydoc).toBe(toBase64(record.ydoc))
    expect(puts[0]?.links).toEqual(['0192a6f0-0000-7000-8000-000000000002'])
    const stored = fields({ ...record, bodyVersion: 1 })
    expect(fields((await sqlite.getNote(record.id))!)).toEqual(stored)
    expect(fields((await storage.getNote(record.id))!)).toEqual(stored)

    await expect(storage.putNote(note({ title: 'Two\nlines' }))).rejects.toThrow(
      'E_NOTE_TITLE_INVALID',
    )
    expect(puts).toHaveLength(1)

    const revision: RevisionRecord = {
      id: 'r1',
      noteId: record.id,
      kind: 'body',
      at: 5,
      ydoc: bytes(1000),
      length: 4,
      value: null,
    }
    await storage.putRevision(revision)
    expect(await storage.getRevision('r1')).toEqual(revision)
    await storage.putRevision({ ...revision, id: 'r2', kind: 'title', ydoc: null, length: null })
    expect((await storage.getRevision('r2'))?.ydoc).toBeNull()
  })
})

describe('the page’s side', () => {
  it('hands states to the commands as they came, without reading them', async () => {
    const record: WireNote = { ...note(), ydoc: toBase64(bytes(MIB)) }
    await tauriWire.putNote(record, ['x'])
    expect(invoke).toHaveBeenCalledWith('note_put', { note: record, links: ['x'], writes: null })
    const sent = vi.mocked(invoke).mock.calls[0]?.[1] as { note: WireNote }
    expect(sent.note).toBe(record)
    // The agent_writes rows go beside the note, as note_put takes them.
    const row = {
      writeId: 'AAAAAAAAAAA',
      kind: 'mcp' as const,
      name: 'Codex',
      at: 1,
      created: false,
    }
    await tauriWire.putNote({ ...record, agentWrites: [row] }, [])
    expect(invoke).toHaveBeenLastCalledWith('note_put', { note: record, links: [], writes: [row] })

    vi.mocked(invoke).mockResolvedValueOnce(record)
    expect(await tauriWire.getNote(record.id)).toBe(record)
    expect(invoke).toHaveBeenLastCalledWith('note_get', { id: record.id, trashed: false })
  })

  it('reads list rows’ bodies for many notes in one call', async () => {
    const bodies = [{ id: 'a', title: 'A', bodyMd: 'text' }]
    vi.mocked(invoke).mockResolvedValueOnce(bodies)
    expect(await tauriStorage.getBodies(['a', 'b'])).toEqual(bodies)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenLastCalledWith('notes_bodies', { ids: ['a', 'b'] })
  })

  it('costs the UI thread no work for each byte of a 4 MiB state', async (context) => {
    const record: WireNote = { ...note(), ydoc: toBase64(bytes(4 * MIB)) }
    vi.mocked(invoke).mockResolvedValue(record)
    const start = performance.now()
    for (let i = 0; i < 50; i += 1) {
      await tauriWire.putNote(record, [])
      await tauriWire.getNote(record.id)
    }
    expectWithinBudget(context, performance.now() - start, 5)
  })
})
