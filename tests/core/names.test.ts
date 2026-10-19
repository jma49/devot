import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clipChars,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  fillPlaceholders,
  isWhitespace,
  MAX_BOOK_NAME_CHARS,
  MAX_TAG_NAME_CHARS,
  readFrontMatter,
  trimWhitespace,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

/**
 * Names and what they are once cleaned (null: no name). The Rust commands
 * check the same cases (src-tauri/src/commands/tags.rs and books.rs), so a
 * name the core cleans is one Rust accepts.
 */
const CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, '../support/names.json'), 'utf8'),
) as { why: string; name: string; clean: string | null }[]
const NAMES = CASES.filter((c) => c.clean !== null)
const NO_NAMES = CASES.filter((c) => c.clean === null)

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function setup() {
  const storage = openSqliteAdapter(join(tempDir('devot-names-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  return {
    notes: createNoteService({ storage, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage, clock, newId }),
    tags: createTagService({ storage, clock, newId }),
  }
}

describe('one whitespace rule for names (as Rust trims)', () => {
  it('reads whitespace as the White_Space property does', () => {
    const differ: number[] = []
    for (let code = 0; code <= 0xffff; code++) {
      const c = String.fromCharCode(code)
      if (isWhitespace(c) !== /^\p{White_Space}$/u.test(c)) differ.push(code)
    }
    expect(differ).toEqual([])
    expect(isWhitespace('\u{1f600}')).toBe(false)
  })

  it.each(CASES)('trims $why', ({ name, clean }) => {
    expect(trimWhitespace(name)).toBe(clean ?? '')
  })

  it.each(NAMES)('cleans a tag name: $why', async ({ name, clean }) => {
    const { tags } = setup()
    const id = await tags.ensure(name)
    expect((await tags.list()).find((t) => t.id === id)?.name).toBe(clean)
    const other = await tags.ensure('Other')
    await tags.rename(other, `Other ${name}`)
    expect((await tags.list()).find((t) => t.id === other)?.name).toBe(
      trimWhitespace(`Other ${name}`),
    )
  })

  it.each(NAMES)('cleans a notebook name: $why', async ({ name, clean }) => {
    const { books } = setup()
    const id = await books.create(name, null)
    expect((await books.list()).find((b) => b.id === id)?.name).toBe(clean)
    await books.rename(id, `${name}${name}`)
    expect((await books.list()).find((b) => b.id === id)?.name).toBe(
      trimWhitespace(`${name}${name}`),
    )
  })

  it.each(NO_NAMES)('refuses a name that is only whitespace: $why', async ({ name }) => {
    const { tags, books } = setup()
    await expect(tags.ensure(name)).rejects.toThrow('E_TAG_NAME_INVALID')
    await expect(books.create(name, null)).rejects.toThrow('E_BOOK_NAME_INVALID')
  })

  it('reads front matter tags by the same rule', () => {
    const meta = readFrontMatter('---\ntags: [Plan\u0085, "\u0085", Draft\uFEFF]\n---\nBody\n')
    expect(meta.tags).toEqual(['Plan', 'Draft\uFEFF'])
  })

  it('trims a whole front matter value by the same rule', () => {
    const bare = readFrontMatter('---\ntags: Draft\uFEFF\n---\nBody\n')
    expect(bare.tags).toEqual(['Draft\uFEFF'])
    const flow = readFrontMatter('---\ntags: [a, b]\u0085\n---\nBody\n')
    expect(flow.tags).toEqual(['a', 'b'])
  })
})

describe('name limits are counted in code points', () => {
  it('clips to a number of code points, never splitting a pair', () => {
    const astral = '\u{1f600}'
    expect(clipChars(astral.repeat(3), 2)).toBe(astral.repeat(2))
    expect(clipChars('abc', 5)).toBe('abc')
    expect(clipChars('abc', 2)).toBe('ab')
  })

  it('takes a name at the limit and refuses one past it', async () => {
    const { tags, books } = setup()
    const astral = '\u{1f600}'
    await expect(tags.ensure(astral.repeat(MAX_TAG_NAME_CHARS))).resolves.toBeTypeOf('string')
    await expect(tags.ensure(astral.repeat(MAX_TAG_NAME_CHARS + 1))).rejects.toThrow(
      'E_TAG_NAME_INVALID',
    )
    await expect(books.create(astral.repeat(MAX_BOOK_NAME_CHARS), null)).resolves.toBeTypeOf(
      'string',
    )
    await expect(books.create('x'.repeat(MAX_BOOK_NAME_CHARS + 1), null)).rejects.toThrow(
      'E_BOOK_NAME_INVALID',
    )
  })
})

describe('tag names stay unique', () => {
  it('refuses renaming a tag onto another tag’s name, in any case', async () => {
    const { notes, tags } = setup()
    const note = await notes.create('A')
    const todo = await tags.addToNote(note, 'todo')
    const dash = await tags.ensure('to-do')
    await expect(tags.rename(dash, 'Todo')).rejects.toThrow('E_TAG_NAME_TAKEN')
    await expect(tags.rename(dash, ' TODO\u0085')).rejects.toThrow('E_TAG_NAME_TAKEN')
    expect((await tags.list()).map((t) => t.name).sort()).toEqual(['to-do', 'todo'])
    await tags.rename(todo, 'ToDo')
    expect((await tags.list()).find((t) => t.id === todo)?.name).toBe('ToDo')
    await tags.remove(todo)
    await tags.rename(dash, 'todo')
    expect((await tags.list()).map((t) => t.name)).toEqual(['todo'])
  })
})

describe('placeholders', () => {
  it('inserts values as typed, replacement patterns included', () => {
    for (const title of ['Notes on $$x$$', 'a $& b', "c $' d", 'e $` f', '$1 $<n>']) {
      expect(fillPlaceholders('Delete “{title}”?', { title })).toBe(`Delete “${title}”?`)
    }
    expect(fillPlaceholders('{a} {b}', { a: '{b}', b: '$&' })).toBe('{b} $&')
  })
})
