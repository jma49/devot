import fc from 'fast-check'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatHlc, NOTE_STATUSES, type NoteRecord, type NoteStatus } from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Concurrent metadata writes from two devices, delivered in any order, must
// end in the same record everywhere: per field, the write with the newest HLC.

type Write =
  | { field: 'title'; value: string; hlc: string }
  | { field: 'book'; value: string | null; hlc: string }
  | { field: 'status'; value: NoteStatus; hlc: string }
  | { field: 'pinned'; value: boolean; hlc: string }

const ID = '0192a6f0-0000-7000-8000-000000000001'

const base: NoteRecord = {
  id: ID,
  title: '',
  titleHlc: formatHlc({ wall: 0, counter: 0, node: 'base' }),
  bodyMd: '',
  ydoc: new Uint8Array([0, 0]),
  bodyVersion: 0,
  bookId: null,
  bookHlc: '',
  status: 'none',
  statusHlc: '',
  pinned: false,
  pinnedHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
}

function asRecord(write: Write): NoteRecord {
  switch (write.field) {
    case 'title':
      return { ...base, title: write.value, titleHlc: write.hlc }
    case 'book':
      return { ...base, bookId: write.value, bookHlc: write.hlc }
    case 'status':
      return { ...base, status: write.value, statusHlc: write.hlc }
    case 'pinned':
      return { ...base, pinned: write.value, pinnedHlc: write.hlc }
  }
}

const hlc = fc
  .record({
    wall: fc.integer({ min: 1, max: 50 }),
    counter: fc.integer({ min: 0, max: 3 }),
    node: fc.constantFrom('mac', 'iphone'),
  })
  .map(formatHlc)

const write: fc.Arbitrary<Write> = fc.oneof(
  fc.record({ field: fc.constant('title' as const), value: fc.string({ maxLength: 5 }), hlc }),
  fc.record({
    field: fc.constant('book' as const),
    value: fc.option(fc.uuid(), { nil: null }),
    hlc,
  }),
  fc.record({
    field: fc.constant('status' as const),
    value: fc.constantFrom(...NOTE_STATUSES),
    hlc,
  }),
  fc.record({ field: fc.constant('pinned' as const), value: fc.boolean(), hlc }),
)

function expected(writes: Write[]) {
  const pick = <F extends Write['field']>(field: F) =>
    writes
      .filter((w): w is Extract<Write, { field: F }> => w.field === field)
      .reduce<Extract<Write, { field: F }> | undefined>(
        (best, w) => (!best || w.hlc > best.hlc ? w : best),
        undefined,
      )
  return {
    title: pick('title')?.value ?? base.title,
    bookId: pick('book')?.value ?? base.bookId,
    status: pick('status')?.value ?? base.status,
    pinned: pick('pinned')?.value ?? base.pinned,
  }
}

describe('per-field last-writer-wins on SQLite', () => {
  it('converges to the newest write per field in any delivery order', async () => {
    const dir = tempDir('devot-merge-')
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(write, { minLength: 1, maxLength: 12, selector: (w) => w.hlc }),
        fc.infiniteStream(fc.nat()),
        async (writes, seeds) => {
          const shuffled = [...writes]
            .map((w) => ({ w, k: seeds.next().value }))
            .sort((a, b) => a.k - b.k)
            .map((x) => x.w)
          const results = []
          for (const order of [writes, shuffled]) {
            const store = openSqliteAdapter(join(dir, `db-${(run += 1)}.sqlite`))
            await store.putNote(base)
            for (const [i, w] of order.entries()) {
              await store.putNote({ ...asRecord(w), bodyVersion: i + 1 })
            }
            const note = (await store.getNote(ID))!
            results.push({
              title: note.title,
              bookId: note.bookId,
              status: note.status,
              pinned: note.pinned,
            })
            store.close()
          }
          expect(results[0]).toEqual(expected(writes))
          expect(results[1]).toEqual(results[0])
        },
      ),
      { numRuns: 60 },
    )
    // 60 runs on real SQLite files: under a second locally, but past the 5 s
    // default once on a slow CI runner.
  }, 30_000)
})
