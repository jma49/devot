import fc from 'fast-check'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBookTree,
  flattenBookTree,
  createBookService,
  createClock,
  createIdGenerator,
  type BookNode,
  type BookRecord,
  type BookService,
  type Clock,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Two devices exchanging writes in any order must converge on the same tree; on one device,
// every move does what was asked and writes one row.

type Op =
  | { kind: 'place'; device: number; book: number; target: number; after: boolean }
  | { kind: 'move'; device: number; book: number; parent: number | null }
  | { kind: 'create'; device: number; parent: number | null }
  | { kind: 'sync'; from: number }

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant('place' as const),
      device: fc.integer({ min: 0, max: 1 }),
      book: fc.nat({ max: 9 }),
      target: fc.nat({ max: 9 }),
      after: fc.boolean(),
    }),
    weight: 6,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      device: fc.integer({ min: 0, max: 1 }),
      book: fc.nat({ max: 9 }),
      parent: fc.option(fc.nat({ max: 9 }), { nil: null }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      device: fc.integer({ min: 0, max: 1 }),
      parent: fc.option(fc.nat({ max: 9 }), { nil: null }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant('sync' as const),
      from: fc.integer({ min: 0, max: 1 }),
    }),
    weight: 1,
  },
)

interface Device {
  storage: SqliteAdapter
  clock: Clock
  books: BookService
  writes: BookRecord[]
  sent: number
}

const dir = tempDir('devot-order-prop-')
let run = 0

function device(node: string): Device {
  const storage = openSqliteAdapter(join(dir, `db-${(run += 1)}.sqlite`))
  const writes: BookRecord[] = []
  const counted: StorageAdapter = {
    ...storage,
    putBook: (book) => {
      writes.push(book)
      return storage.putBook(book)
    },
  }
  const clock = createClock(node)
  const books = createBookService({ storage: counted, clock, newId: createIdGenerator() })
  return { storage, clock, books, writes, sent: 0 }
}

async function sync(from: Device, to: Device, seed: number) {
  const batch = from.writes.slice(from.sent)
  from.sent = from.writes.length
  for (const book of shuffled(batch, seed)) {
    for (const hlc of [book.nameHlc, book.parentHlc, book.sortKeyHlc])
      if (hlc) to.clock.receive(hlc)
    await to.storage.putBook(book)
  }
}

type Shape = [string, Shape[]]
const shape = (nodes: BookNode[]): Shape[] => nodes.map((n) => [n.id, shape(n.children)])

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function siblingsOf(tree: BookNode[], id: string): string[] | undefined {
  if (tree.some((n) => n.id === id)) return tree.map((n) => n.id)
  for (const node of tree) {
    const found = siblingsOf(node.children, id)
    if (found) return found
  }
  return undefined
}

async function attempt(change: () => Promise<unknown>): Promise<string | null> {
  try {
    await change()
    return null
  } catch (error) {
    return (error as Error).message
  }
}

/** Codes a random change may end with: moving into its own sub-notebooks is refused. */
const ALLOWED = [null, 'E_BOOK_CYCLE']

describe('manual notebook order across devices', () => {
  it('converges to the same tree and order on both devices', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.array(op, { minLength: 1, maxLength: 25 }),
        fc.nat(),
        async (initial, ops, seed) => {
          const devices = [device('mac'), device('iphone')]
          const [mac, iphone] = devices as [Device, Device]
          for (let i = 0; i < initial; i += 1) await mac.books.create(`Book ${i}`, null)
          await sync(mac, iphone, seed)
          for (const step of ops) {
            if (step.kind === 'sync') {
              await sync(devices[step.from]!, devices[1 - step.from]!, seed)
              continue
            }
            const here = devices[step.device]!
            const ids = (await here.books.list()).map((b) => b.id).sort()
            const pick = (n: number) => ids[n % ids.length]!
            const parent = 'parent' in step && step.parent !== null ? pick(step.parent) : null
            const code = await attempt(() =>
              step.kind === 'place'
                ? here.books.place(
                    pick(step.book),
                    pick(step.target),
                    step.after ? 'after' : 'before',
                  )
                : step.kind === 'move'
                  ? here.books.move(pick(step.book), parent)
                  : here.books.create('New', parent),
            )
            expect(ALLOWED).toContain(code)
          }
          await sync(mac, iphone, seed)
          await sync(iphone, mac, seed + 1)
          const byId = (a: BookRecord, b: BookRecord) => (a.id < b.id ? -1 : 1)
          const macBooks = (await mac.storage.listBooks()).sort(byId)
          const iphoneBooks = await iphone.storage.listBooks()
          expect(shuffled(iphoneBooks, seed).sort(byId)).toEqual(macBooks)
          expect(shape(buildBookTree(shuffled(iphoneBooks, seed)))).toEqual(
            shape(buildBookTree(macBooks)),
          )
          for (const d of devices) d.storage.close()
        },
      ),
      { numRuns: 40 },
    )
  }, 60_000)

  it('on one device, a move lands where asked and writes one row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.array(op, { minLength: 1, maxLength: 30 }),
        async (initial, ops) => {
          const here = device('mac')
          for (let i = 0; i < initial; i += 1) await here.books.create(`Book ${i}`, null)
          for (const step of ops) {
            if (step.kind !== 'place' && step.kind !== 'move') continue
            const ids = (await here.books.list()).map((b) => b.id).sort()
            const pick = (n: number) => ids[n % ids.length]!
            const id = pick(step.book)
            const before = buildBookTree(await here.books.list())
            here.writes.length = 0
            let expected = siblingsOf(before, id)!
            let code: string | null
            // Placing a notebook beside itself writes nothing.
            let rows = 1
            if (step.kind === 'place') {
              const target = pick(step.target)
              if (target === id) rows = 0
              else {
                expected = siblingsOf(before, target)!.filter((s) => s !== id)
                expected.splice(expected.indexOf(target) + (step.after ? 1 : 0), 0, id)
              }
              code = await attempt(() =>
                here.books.place(id, target, step.after ? 'after' : 'before'),
              )
            } else {
              const parent = step.parent === null ? null : pick(step.parent)
              const under =
                parent === null
                  ? before
                  : flattenBookTree(before).find((n) => n.id === parent)!.children
              expected = [...under.map((n) => n.id).filter((s) => s !== id), id]
              code = await attempt(() => here.books.move(id, parent))
            }
            expect(ALLOWED).toContain(code)
            const after = buildBookTree(await here.books.list())
            expect(siblingsOf(after, id)).toEqual(code === null ? expected : siblingsOf(before, id))
            expect(here.writes.length).toBe(code === null ? rows : 0)
          }
          here.storage.close()
        },
      ),
      { numRuns: 40 },
    )
  }, 60_000)
})
