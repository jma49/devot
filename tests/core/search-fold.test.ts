import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  parseSearch,
  resolveSearch,
} from '../../src/core'
import { foldText, scanFolding } from '../../src/core/search'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Text shorter than three characters is scanned in SQL, not looked up in the
// trigram index (which folds case for every script). Both stores scan with
// the same SQL function, devot_fold, so a short term finds what a long one
// would: tests/support/folds.json holds the cases the Rust store (storage
// tests) and this adapter agree on.

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-fold-'), 'devot.sqlite'))
  open.push(storage)
  const notes = createNoteService({
    storage,
    clock: createClock('mac1'),
    newId: createIdGenerator(),
    saveDelayMs: 5,
  })
  return { storage, notes }
}

interface FoldCase {
  why: string
  text: string
  folded: string
}
const CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, '../support/folds.json'), 'utf8'),
) as FoldCase[]

describe('devot_fold', () => {
  it('folds the shared cases', () => {
    const { storage } = setup()
    expect(CASES.length).toBeGreaterThan(10)
    for (const c of CASES) {
      const row = storage.db.prepare('SELECT devot_fold(?) AS folded').get(c.text) as {
        folded: string
      }
      expect({ why: c.why, folded: row.folded }).toEqual({ why: c.why, folded: c.folded })
    }
  })

  it('leaves nothing as nothing', () => {
    const { storage } = setup()
    const row = storage.db.prepare('SELECT devot_fold(NULL) AS folded').get() as {
      folded: string | null
    }
    expect(row.folded).toBeNull()
  })
})

describe('short search terms', () => {
  it('ignore case in every script, as long ones do', async () => {
    const { notes } = setup()
    const id = await notes.create('Émile and the ÉCOLE', null)
    await notes.setBody(id, 'Ünal АБ Ångström')
    await notes.flush()
    const found = async (query: string) => (await notes.search(query)).map((n) => n.id)
    for (const term of [
      'ém',
      'ÉM',
      'éc',
      'Éc',
      'ün',
      'ÜN',
      'аб',
      'ån',
      'ÅN',
      // Long terms use the index: the same notes.
      'émi',
      'ÉMI',
      'école',
    ]) {
      expect({ term, ids: await found(term) }).toEqual({ term, ids: [id] })
    }
    expect(await found('éx')).toEqual([])
    expect(await found('-ÉM')).toEqual([])
    expect(await found('title:ém')).toEqual([id])
    expect(await found('body:ém')).toEqual([])
    expect(await found('body:ün')).toEqual([id])
  })
})

describe('scans of short terms', () => {
  const codePoints = function* () {
    for (let c = 0; c <= 0x10ffff; c += 1) if (c < 0xd800 || c > 0xdfff) yield c
  }

  it('skip folding only where folding could change nothing', () => {
    // `none`: no other character folds to a caseless one; `ascii`: only the
    // Kelvin sign folds to ASCII from outside it.
    const toCaseless: number[] = []
    const toAscii: number[] = []
    // And a caseless character folds to itself.
    const unfolded: number[] = []
    for (const c of codePoints()) {
      const folded = foldText(String.fromCodePoint(c))
      if (scanFolding(folded) === 'none' && folded.codePointAt(0) !== c) toCaseless.push(c)
      if (scanFolding(String.fromCodePoint(c)) === 'none' && folded.codePointAt(0) !== c) {
        unfolded.push(c)
      }
      if (c >= 0x80 && /^[\0-\x7f]$/.test(folded)) toAscii.push(c)
    }
    expect(toCaseless).toEqual([])
    expect(toAscii).toEqual([0x212a])
    expect(unfolded).toEqual([])
    expect(scanFolding('\u{9884}\u{89c8}')).toBe('none')
    expect(scanFolding('1-')).toBe('none')
    expect(scanFolding('a\u{9884}')).toBe('ascii')
    expect(scanFolding('Qz')).toBe('ascii')
    expect(scanFolding('\u{e9}m')).toBe('fold')
    expect(scanFolding('\u{212a}')).toBe('fold')
    expect(scanFolding('\u{ff21}')).toBe('fold')
  })

  it("rely on SQLite's lower() folding A-Z alone", () => {
    const { storage } = setup()
    const others = [...codePoints()].filter((c) => c >= 0x80).map((c) => String.fromCodePoint(c))
    const text = others.join('')
    const sql = storage.db.prepare<[string, string], { same: number }>(
      'SELECT lower(?) = ? AS same',
    )
    expect(sql.get(text, text)?.same).toBe(1)
    const ascii = Array.from({ length: 0x80 }, (_, c) => String.fromCharCode(c)).join('')
    const lower = storage.db.prepare<[string], { l: string }>('SELECT lower(?) AS l').get(ascii)
    expect(lower?.l).toBe(ascii.replace(/[A-Z]/g, (c) => c.toLowerCase()))
  })

  it('find what folding finds, in rank order, stopping at a page', async () => {
    const { storage } = setup()
    const bodies = [
      ['a', 'Merge AB', 'the \u{9884}\u{89c8} pane'],
      ['b', 'merge', 'THE \u{212a}elvin a\u{9884} line'],
      ['c', 'Merge \u{ff21}\u{ff22}', 'ab\nkb'],
      ['d', 'merge ends a', '\u{9884}\u{89c8}'],
      ['e', 'plain', 'merge only 1-2'],
    ] as const
    const service = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      saveDelayMs: 5,
    })
    const ids = new Map<string, string>()
    for (const [key, title, body] of bodies) {
      const id = await service.create(title, null)
      await service.setBody(id, body)
      await service.flush()
      ids.set(id, key)
    }
    const search = async (query: string, limit: number) => {
      const resolved = resolveSearch(parseSearch(query), { books: [], tags: [] })
      if (!resolved) throw new Error('E_TEST_QUERY')
      return (await storage.searchNotes(resolved, limit)).map((n) => ids.get(n.id)!)
    }
    // What folding the title, a line break and the body finds, in the order
    // of `order` (the notes' ranks for `merge`, or the list's order).
    const expected = (term: string, field: string, negate: boolean, order: string[]) =>
      order.filter((key) => {
        const [, title, body] = bodies.find((b) => b[0] === key)!
        const haystack = field === 'title' ? title : field === 'body' ? body : `${title}\n${body}`
        return foldText(haystack).includes(foldText(term)) !== negate
      })
    const byRank = await search('merge', 50)
    const listed = await search('', 50)
    expect(byRank).toHaveLength(5)
    for (const term of [
      '\u{9884}\u{89c8}',
      'a\u{9884}',
      'ab',
      'AB',
      'k',
      'K',
      '\u{ff41}',
      '1-',
      's a',
    ]) {
      for (const field of ['any', 'title', 'body']) {
        for (const negate of [false, true]) {
          const clause = `${negate ? '-' : ''}${field === 'any' ? '' : `${field}:`}"${term}"`
          const want = expected(term, field, negate, byRank)
          expect({ clause, found: await search(`merge ${clause}`, 50) }).toEqual({
            clause,
            found: want,
          })
          expect({ clause, found: await search(`merge ${clause}`, 1) }).toEqual({
            clause,
            found: want.slice(0, 1),
          })
          expect({ clause, found: await search(clause, 50) }).toEqual({
            clause,
            found: expected(term, field, negate, listed),
          })
        }
      }
    }
    // Search text is trimmed, so only a query built by hand has a short term
    // with a line break: that one may run from the title into the body.
    const across = await storage.searchNotes(
      { text: [{ field: 'any', value: 'a\n', negate: false }], sets: [], pinned: null },
      50,
    )
    expect(across.map((n) => ids.get(n.id))).toEqual(expected('a\n', 'any', false, listed))
  })
})
