import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClock,
  createIdGenerator,
  createNoteService,
  DEFAULT_NOTE_SORT,
  NOTE_SORTS,
  noteGroups,
  noteSortId,
  parseNoteSort,
  sortNotes,
  type NoteSort,
} from '../../src/core'
import { compareNames } from '../../src/core/sort'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Han characters read an, bei and zhong in pinyin; their code points run the
// other way (zhong < bei < an).
const AN = '\u5b89'
const BEI = '\u5317'
const ZHONG = '\u4e2d'

interface Row {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
}

let next = 0
const row = (title: string, createdAt: number, updatedAt: number, pinned = false): Row => ({
  id: `0192a6f0-0000-7000-8000-${String(++next).padStart(12, '0')}`,
  title,
  createdAt,
  updatedAt,
  pinned,
})

const sort = (key: NoteSort['key'], direction: NoteSort['direction']): NoteSort => ({
  key,
  direction,
})
const titles = (rows: readonly Row[]) => rows.map((r) => r.title)

describe('the six orders', () => {
  const a = row('Alpha', 30, 200)
  const b = row('beta', 10, 300)
  const c = row('Gamma', 20, 100)
  const notes = [c, a, b]

  it('lists all six, newest updated first by default', () => {
    expect(NOTE_SORTS.map(noteSortId)).toEqual([
      'title-asc',
      'title-desc',
      'updated-desc',
      'updated-asc',
      'created-desc',
      'created-asc',
    ])
    expect(DEFAULT_NOTE_SORT).toEqual(sort('updated', 'desc'))
  })

  it('sorts by title, A to Z and Z to A, ignoring case', () => {
    expect(titles(sortNotes(notes, sort('title', 'asc'), 'en'))).toEqual(['Alpha', 'beta', 'Gamma'])
    expect(titles(sortNotes(notes, sort('title', 'desc'), 'en'))).toEqual([
      'Gamma',
      'beta',
      'Alpha',
    ])
  })

  it('sorts by date updated, newest or oldest first', () => {
    expect(titles(sortNotes(notes, sort('updated', 'desc'), 'en'))).toEqual([
      'beta',
      'Alpha',
      'Gamma',
    ])
    expect(titles(sortNotes(notes, sort('updated', 'asc'), 'en'))).toEqual([
      'Gamma',
      'Alpha',
      'beta',
    ])
  })

  it('sorts by date created, newest or oldest first', () => {
    expect(titles(sortNotes(notes, sort('created', 'desc'), 'en'))).toEqual([
      'Alpha',
      'Gamma',
      'beta',
    ])
    expect(titles(sortNotes(notes, sort('created', 'asc'), 'en'))).toEqual([
      'beta',
      'Gamma',
      'Alpha',
    ])
  })

  it('returns a new array and leaves its input alone', () => {
    const input = [...notes]
    const out = sortNotes(input, sort('title', 'asc'), 'en')
    expect(out).not.toBe(input)
    expect(input).toEqual(notes)
  })

  it('breaks date ties by ID, in the same direction', () => {
    const first = row('First', 5, 5)
    const second = row('Second', 5, 5)
    expect(titles(sortNotes([first, second], sort('updated', 'desc'), 'en'))).toEqual([
      'Second',
      'First',
    ])
    expect(titles(sortNotes([second, first], sort('created', 'asc'), 'en'))).toEqual([
      'First',
      'Second',
    ])
  })

  it('breaks title ties by date updated, newest first, in both directions', () => {
    const older = row('Same', 1, 10)
    const newer = row('same', 2, 20)
    for (const direction of ['asc', 'desc'] as const) {
      expect(sortNotes([older, newer], sort('title', direction), 'en')).toEqual([newer, older])
    }
  })
})

describe('title collation', () => {
  it('compares numbers by value', () => {
    const notes = [row('Note 10', 1, 1), row('Note 2', 2, 2), row('Note 1', 3, 3)]
    expect(titles(sortNotes(notes, sort('title', 'asc'), 'en'))).toEqual([
      'Note 1',
      'Note 2',
      'Note 10',
    ])
  })

  it('treats accents and case as equal, then puts the newest updated first', () => {
    const notes = [row('eclair', 1, 1), row('\u00c9clair', 2, 2), row('Echo', 3, 3)]
    expect(titles(sortNotes(notes, sort('title', 'asc'), 'en'))).toEqual([
      'Echo',
      '\u00c9clair',
      'eclair',
    ])
  })

  it('sorts Chinese titles by pinyin in a Chinese locale, English ones alphabetically', () => {
    const notes = [ZHONG, 'banana', BEI, 'Apple', AN].map((t, i) => row(t, i, i))
    expect(titles(sortNotes(notes, sort('title', 'asc'), 'zh-Hans-CN'))).toEqual([
      AN,
      BEI,
      ZHONG,
      'Apple',
      'banana',
    ])
    expect(titles(sortNotes(notes, sort('title', 'asc'), ['zh-CN', 'en']))).toEqual([
      AN,
      BEI,
      ZHONG,
      'Apple',
      'banana',
    ])
  })

  it('puts English before Chinese titles in an English locale', () => {
    const notes = [ZHONG, 'banana', AN, 'Apple'].map((t, i) => row(t, i, i))
    const sorted = titles(sortNotes(notes, sort('title', 'asc'), 'en'))
    expect(sorted.slice(0, 2)).toEqual(['Apple', 'banana'])
    expect(new Set(sorted.slice(2))).toEqual(new Set([AN, ZHONG]))
  })

  it('keeps untitled notes last in both directions, newest updated first', () => {
    const blankOld = row('', 1, 1)
    const blankNew = row('', 2, 2)
    const notes = [blankOld, row('Zed', 3, 3), blankNew, row('Ant', 4, 4)]
    expect(sortNotes(notes, sort('title', 'asc'), 'en').map((n) => n.title || n.id)).toEqual([
      'Ant',
      'Zed',
      blankNew.id,
      blankOld.id,
    ])
    expect(sortNotes(notes, sort('title', 'desc'), 'en').map((n) => n.title || n.id)).toEqual([
      'Zed',
      'Ant',
      blankNew.id,
      blankOld.id,
    ])
  })

  it('falls back to the default locale for an unknown locale tag', () => {
    const notes = [row('b', 1, 1), row('a', 2, 2)]
    expect(titles(sortNotes(notes, sort('title', 'asc'), 'not a locale!'))).toEqual(['a', 'b'])
  })
})

describe('compareNames', () => {
  // The order the sidebar's tags and the tag suggestions use, so `tag10` follows `tag4` (A156).
  it('compares numbers by value and treats case and accents as equal', () => {
    expect(['tag10', 'tag4', 'tag2'].sort((a, b) => compareNames(a, b, 'en'))).toEqual([
      'tag2',
      'tag4',
      'tag10',
    ])
    expect(compareNames('cafe', 'Caf\u00e9', 'en')).toBe(0)
    expect(compareNames('Caf\u00e9', 'Cafe\u0301', 'en')).toBe(0)
  })
})

describe('pinned notes', () => {
  it('stay in their own group, sorted the same way, for every order', () => {
    const notes = [
      row('Delta', 4, 10, true),
      row('alpha', 2, 40),
      row('Charlie', 1, 30, true),
      row('Bravo', 3, 20),
      row('echo', 5, 50, true),
    ]
    for (const order of NOTE_SORTS) {
      const sorted = sortNotes(notes, order, 'en')
      const groups = noteGroups(sorted)
      expect(groups.pinned.every((n) => n.pinned)).toBe(true)
      expect(groups.others.every((n) => !n.pinned)).toBe(true)
      expect(groups.pinned).toEqual(sorted.filter((n) => n.pinned))
      expect(groups.others).toEqual(sorted.filter((n) => !n.pinned))
    }
    const byTitle = noteGroups(sortNotes(notes, sort('title', 'asc'), 'en'))
    expect(titles(byTitle.pinned)).toEqual(['Charlie', 'Delta', 'echo'])
    expect(titles(byTitle.others)).toEqual(['alpha', 'Bravo'])
    const oldestCreated = noteGroups(sortNotes(notes, sort('created', 'asc'), 'en'))
    expect(titles(oldestCreated.pinned)).toEqual(['Charlie', 'Delta', 'echo'])
    expect(titles(oldestCreated.others)).toEqual(['alpha', 'Bravo'])
    const oldestUpdated = noteGroups(sortNotes(notes, sort('updated', 'asc'), 'en'))
    expect(titles(oldestUpdated.pinned)).toEqual(['Delta', 'Charlie', 'echo'])
    expect(titles(oldestUpdated.others)).toEqual(['Bravo', 'alpha'])
  })
})

describe('parseNoteSort', () => {
  it('reads every ID it writes', () => {
    for (const order of NOTE_SORTS) expect(parseNoteSort(noteSortId(order))).toEqual(order)
  })

  it('rejects anything else', () => {
    for (const value of [null, undefined, '', 'title', 'title-up', 'size-asc', 3, 'TITLE-ASC']) {
      expect(parseNoteSort(value)).toBeUndefined()
    }
  })
})

describe('notes listed from SQLite', () => {
  const open: SqliteAdapter[] = []
  afterEach(() => open.splice(0).forEach((a) => a.close()))

  it('carry their creation time, so every order works on stored notes', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-sort-'), 'devot.sqlite'))
    open.push(storage)
    let time = 1_000
    const notes = createNoteService({
      storage,
      clock: createClock('mac1'),
      newId: createIdGenerator(),
      now: () => time,
      saveDelayMs: 5,
    })
    const first = await notes.create('Zulu')
    time = 2_000
    await notes.create('yankee')
    time = 3_000
    await notes.create('Xray')
    time = 4_000
    await notes.setTitle(first, 'Zulu 2')
    await notes.flush()

    const listed = await notes.list()
    expect(listed.map((n) => [n.title, n.createdAt, n.updatedAt])).toEqual([
      ['Zulu 2', 1_000, 4_000],
      ['Xray', 3_000, 3_000],
      ['yankee', 2_000, 2_000],
    ])
    expect(titles(sortNotes(listed, sort('created', 'asc'), 'en') as Row[])).toEqual([
      'Zulu 2',
      'yankee',
      'Xray',
    ])
    expect(titles(sortNotes(listed, sort('title', 'asc'), 'en') as Row[])).toEqual([
      'Xray',
      'yankee',
      'Zulu 2',
    ])

    const { found } = await notes.search('Zulu')
    expect(found.map((n) => n.createdAt)).toEqual([1_000])
  })
})
