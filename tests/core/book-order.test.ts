import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBookTree,
  createAiService,
  createBookService,
  createClock,
  createIdGenerator,
  flattenBookTree,
  formatHlc,
  sequentialKeys,
  type BookNode,
  type BookRecord,
  type StorageAdapter,
} from '../../src/core'
import { openSqliteAdapter, SCHEMA_VERSION, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const tempPath = () => join(tempDir('devot-order-'), 'devot.sqlite')

function setup(path = tempPath(), locale?: string) {
  const storage = openSqliteAdapter(path)
  open.push(storage)
  const writes: BookRecord[] = []
  const counted: StorageAdapter = {
    ...storage,
    putBook: (book) => {
      writes.push(book)
      return storage.putBook(book)
    },
  }
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const books = createBookService({
    storage: counted,
    clock,
    newId,
    ...(locale ? { locale } : {}),
  })
  const tree = async () => buildBookTree(await books.list())
  return { storage, books, writes, tree, clock, newId }
}

type Shape = string | [string, Shape[]]
const shape = (nodes: BookNode[]): Shape[] =>
  nodes.map((n) => (n.children.length > 0 ? [n.name, shape(n.children)] : n.name))

describe('manual notebook order', () => {
  it('puts a new notebook after its siblings, whatever its name', async () => {
    const { books, tree } = setup()
    const work = await books.create('Work', null)
    await books.create('Archive', null)
    await books.create('Zed', work)
    await books.create('Apple', work)
    expect(shape(await tree())).toEqual([['Work', ['Zed', 'Apple']], 'Archive'])
  })

  it('places a notebook before or after another, writing one row', async () => {
    const { books, writes, tree } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const c = await books.create('C', null)
    writes.length = 0
    await books.place(c, a, 'before')
    expect(shape(await tree())).toEqual(['C', 'A', 'B'])
    await books.place(c, a, 'after')
    expect(shape(await tree())).toEqual(['A', 'C', 'B'])
    await books.place(a, b, 'after')
    expect(shape(await tree())).toEqual(['C', 'B', 'A'])
    await books.place(b, c, 'before')
    expect(shape(await tree())).toEqual(['B', 'C', 'A'])
    expect(writes.map((w) => w.id)).toEqual([c, c, a, b])
  })

  it('takes the parent of the notebook it is placed beside', async () => {
    const { books, writes, tree } = setup()
    const work = await books.create('Work', null)
    const plan = await books.create('Plan', work)
    await books.create('Notes', work)
    const loose = await books.create('Loose', null)
    writes.length = 0
    await books.place(loose, plan, 'after')
    expect(shape(await tree())).toEqual([['Work', ['Plan', 'Loose', 'Notes']]])
    await books.place(plan, work, 'after')
    expect(shape(await tree())).toEqual([['Work', ['Loose', 'Notes']], 'Plan'])
    expect(writes.map((w) => w.id)).toEqual([loose, plan])
    const record = (await books.list()).find((b) => b.id === plan)!
    expect(record.parentId).toBeNull()
  })

  it('keeps the parent clock when the parent does not change', async () => {
    const { books } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const before = (await books.list()).find((r) => r.id === b)!
    await books.place(b, a, 'before')
    const after = (await books.list()).find((r) => r.id === b)!
    expect(after.parentHlc).toBe(before.parentHlc)
    expect(after.sortKeyHlc > before.sortKeyHlc).toBe(true)
  })

  it('never places a notebook inside itself', async () => {
    const { books, writes } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', a)
    writes.length = 0
    await expect(books.place(a, b, 'before')).rejects.toThrow('E_BOOK_CYCLE')
    await expect(books.place(a, 'missing', 'before')).rejects.toThrow('E_BOOK_NOT_FOUND')
    await expect(books.place('missing', a, 'before')).rejects.toThrow('E_BOOK_NOT_FOUND')
    await books.place(a, a, 'after')
    expect(writes).toEqual([])
  })

  it('moving into a notebook puts it after the sub-notebooks there, in one row', async () => {
    const { books, writes, tree } = setup()
    const work = await books.create('Work', null)
    await books.create('Zed', work)
    const apple = await books.create('Apple', null)
    writes.length = 0
    await books.move(apple, work)
    expect(shape(await tree())).toEqual([['Work', ['Zed', 'Apple']]])
    await books.move(apple, null)
    expect(shape(await tree())).toEqual([['Work', ['Zed']], 'Apple'])
    expect(writes.map((w) => w.id)).toEqual([apple, apple])
  })

  const remote = (clock: ReturnType<typeof createClock>) => {
    const hlc = formatHlc({ wall: Date.now() + 1000, counter: 0, node: 'iphone' })
    clock.receive(hlc)
    return hlc
  }

  it('breaks equal keys by ID, and places between them by giving them new keys', async () => {
    const { storage, books, tree, clock } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const c = await books.create('C', null)
    const all = await books.list()
    const keyOf = (id: string) => all.find((r) => r.id === id)!.sortKey
    for (const id of [b, c]) {
      const record = all.find((r) => r.id === id)!
      await storage.putBook({ ...record, sortKey: keyOf(a), sortKeyHlc: remote(clock) })
    }
    // a < b < c by ID (UUIDv7), so the order is A, B, C.
    expect(shape(await tree())).toEqual(['A', 'B', 'C'])
    const d = await books.create('D', null)
    await books.place(d, b, 'after')
    expect(shape(await tree())).toEqual(['A', 'B', 'D', 'C'])
    await books.place(d, b, 'before')
    expect(shape(await tree())).toEqual(['A', 'D', 'B', 'C'])
    const keys = (await books.list()).map((r) => r.sortKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('sorts a notebook with a malformed key from sync first and still places beside it', async () => {
    const { storage, books, tree, clock } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const record = (await books.list()).find((r) => r.id === b)!
    await storage.putBook({ ...record, sortKey: '', sortKeyHlc: remote(clock) })
    expect(shape(await tree())).toEqual(['B', 'A'])
    const c = await books.create('C', null)
    await books.place(c, b, 'after')
    expect(shape(await tree())).toEqual(['B', 'C', 'A'])
    await books.place(a, b, 'before')
    expect(shape(await tree())).toEqual(['A', 'B', 'C'])
  })

  it('merges the key by its own HLC: a stale copy never undoes a move', async () => {
    const { storage, books, tree } = setup()
    const a = await books.create('A', null)
    const b = await books.create('B', null)
    const stale = (await books.list()).find((r) => r.id === b)!
    await books.place(b, a, 'before')
    await storage.putBook({ ...stale, name: 'Renamed', nameHlc: '9999999999999999-0000-zz' })
    expect(shape(await tree())).toEqual(['Renamed', 'A'])
  })

  it('reordering a notebook shown at the top level for a missing parent keeps that parent', async () => {
    const { storage, books, tree } = setup()
    const gone = await books.create('Gone', null)
    const orphan = await books.create('Orphan', gone)
    const top = await books.create('Top', null)
    const parent = (await books.list()).find((r) => r.id === gone)!
    await storage.putBook({ ...parent, deletedAt: 1, deletedHlc: '9999999999999999-0000-zz' })
    expect(shape(await tree())).toEqual(['Orphan', 'Top'])
    const before = (await books.list()).find((r) => r.id === orphan)!
    await books.place(orphan, top, 'after')
    expect(shape(await tree())).toEqual(['Top', 'Orphan'])
    const after = (await books.list()).find((r) => r.id === orphan)!
    expect([after.parentId, after.parentHlc]).toEqual([gone, before.parentHlc])
  })

  it('merges keys with equal clocks (old notebooks keyed apart) to the same key in any order', async () => {
    const migrated = (sortKey: string): BookRecord => ({
      id: '0192a6f0-0000-7000-8000-000000000001',
      name: 'Work',
      nameHlc: 'h',
      parentId: null,
      parentHlc: 'h',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      deletedHlc: null,
      aiAccess: false,
      aiAccessHlc: '',
      icon: null,
      iconColor: null,
      iconHlc: '',
      sortKey,
      sortKeyHlc: '',
    })
    const [mac, iphone] = [setup(), setup()]
    const id = migrated('a0').id
    await mac.storage.putBook(migrated('a1'))
    await mac.storage.putBook(migrated('a3'))
    await iphone.storage.putBook(migrated('a3'))
    await iphone.storage.putBook(migrated('a1'))
    const keyIn = async (s: SqliteAdapter) =>
      (await s.listBooks()).find((r) => r.id === id)?.sortKey
    expect(await keyIn(mac.storage)).toBe('a3')
    expect(await keyIn(iphone.storage)).toBe('a3')
  })

  it('devot-mcp lists notebooks in the sidebar order', async () => {
    const { storage, books, clock, newId } = setup()
    const ai = createAiService({ storage, clock, newId })
    const zed = await books.create('Zed', null)
    const inner = await books.create('Inner', zed)
    const alpha = await books.create('Alpha', null)
    const hidden = await books.create('Hidden', null)
    for (const id of [zed, inner, alpha]) await books.setAiAccess(id, true)
    await books.place(hidden, zed, 'before')
    expect((await ai.notebooks()).map((n) => n.name)).toEqual(['Zed', 'Inner', 'Alpha'])
    await books.place(alpha, zed, 'before')
    expect((await ai.notebooks()).map((n) => n.name)).toEqual(['Alpha', 'Zed', 'Inner'])
  })
})

describe('the schema v10 migration', () => {
  const migrations = readdirSync(join(import.meta.dirname, '../../src-tauri/migrations'))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(join(import.meta.dirname, '../../src-tauri/migrations', f), 'utf8'))

  function version9(books: [string, number | null, boolean?][]): { path: string; ids: string[] } {
    const path = tempPath()
    const db = new Database(path)
    migrations.slice(0, 9).forEach((sql, i) => {
      db.exec(sql)
      db.pragma(`user_version = ${i + 1}`)
    })
    const ids = books.map((_, i) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`)
    ids.reverse()
    const insert = db.prepare(
      `INSERT INTO books (id, name, name_hlc, parent_id, parent_hlc, created_at, updated_at,
                          deleted_at, deleted_hlc)
       VALUES (?, ?, 'h', ?, 'h', 1, 1, ?, ?)`,
    )
    books.forEach(([name, parent, deleted], i) => {
      insert.run(
        ids[i],
        name,
        parent === null ? null : ids[parent],
        deleted ? 2 : null,
        deleted ? 'h' : null,
      )
    })
    db.close()
    return { path, ids }
  }

  it('leaves keys unset, and the core keys notebooks in the name order shown before', async () => {
    const items: [string, number | null][] = Array.from({ length: 70 }, (_, i) => [
      `Item ${String(69 - i).padStart(2, '0')}`,
      3,
    ])
    const { path, ids } = version9([
      ['beta', null],
      ['Gamma', null],
      ['alpha', null],
      ['Alpha', null],
      ['Zed', 0],
      ['apple', 0],
      ['Gone', null, true],
      ...items,
    ])
    const { storage, books, tree, writes } = setup(path)
    expect(storage.schemaVersion()).toBe(SCHEMA_VERSION)
    const unset = await books.list()
    expect(unset.every((r) => r.sortKey === '' && r.sortKeyHlc === '')).toBe(true)
    const expectOldOrder = async () => {
      const result = await tree()
      expect(result.map((n) => n.id)).toEqual([ids[3], ids[2], ids[0], ids[1]])
      expect(shape(result.slice(2))).toEqual([['beta', ['apple', 'Zed']], 'Gamma'])
      expect(result[0]?.children.map((n) => n.name)).toEqual(
        Array.from({ length: 70 }, (_, i) => `Item ${String(i).padStart(2, '0')}`),
      )
    }
    await expectOldOrder()

    await books.settleOrder()
    await expectOldOrder()
    // The keys are the ones the core counts up with, from 'a0' per parent,
    // and the key clock stays unset so any later move wins.
    const records = await books.list()
    const keysUnder = (parent: string | null) =>
      flattenBookTree(buildBookTree(records))
        .filter((n) => n.parentId === parent)
        .map((n) => records.find((r) => r.id === n.id)!.sortKey)
    expect(keysUnder(null)).toEqual(sequentialKeys(4))
    expect(keysUnder(ids[0]!)).toEqual(sequentialKeys(2))
    expect(keysUnder(ids[3]!)).toEqual(sequentialKeys(70))
    expect(records.every((r) => r.sortKeyHlc === '')).toBe(true)
    writes.length = 0
    await books.settleOrder()
    expect(writes).toEqual([])
  })

  it('keys accented and other-script names in the collation order shown before', async () => {
    const { path } = version9([
      ['Zebra', null],
      ['\u00c9clair', null],
      ['apple', null],
      ['Notes', null],
      ['\u4e2d', 3],
      ['\u5b89', 3],
      ['\u5317', 3],
    ])
    const { books, tree } = setup(path, 'zh')
    await books.settleOrder()
    expect(shape(await tree())).toEqual([
      'apple',
      '\u00c9clair',
      ['Notes', ['\u5b89', '\u5317', '\u4e2d']],
      'Zebra',
    ])
  })

  it('keys unkeyed notebooks before keyed siblings, without touching those', async () => {
    const { path, ids } = version9([
      ['Beta', null],
      ['Alpha', null],
    ])
    const { storage, books, tree, writes, clock } = setup(path)
    // A keyed notebook from sync arrived before the core keyed the others.
    await storage.putBook({
      id: '0192a6f0-0000-7000-8000-00000000ffff',
      name: 'Late',
      nameHlc: 'h',
      parentId: null,
      parentHlc: 'h',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      deletedHlc: null,
      aiAccess: false,
      aiAccessHlc: '',
      icon: null,
      iconColor: null,
      iconHlc: '',
      sortKey: 'a0',
      sortKeyHlc: clock.tick(),
    })
    expect(shape(await tree())).toEqual(['Alpha', 'Beta', 'Late'])
    writes.length = 0
    await books.settleOrder()
    expect(shape(await tree())).toEqual(['Alpha', 'Beta', 'Late'])
    expect(writes.map((w) => w.id).sort()).toEqual([...ids].sort())
    expect(writes.every((w) => w.sortKeyHlc === '' && w.sortKey < 'a0')).toBe(true)
  })
})
