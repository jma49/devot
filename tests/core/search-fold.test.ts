import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClock, createIdGenerator, createNoteService } from '../../src/core'
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
