import { describe, expect, it } from 'vitest'
import { noteLink } from './links'
import { checkNote, clipTitle, MAX_BODY_BYTES, MAX_TITLE_CHARS } from './noteLimits'
import type { NoteRecord } from './storage'

const smile = '\u{1F600}'

describe('clipTitle', () => {
  it('keeps a title that fits as typed, spaces included', () => {
    expect(clipTitle('  Plan  for  May ')).toBe('  Plan  for  May ')
    expect(clipTitle('x'.repeat(MAX_TITLE_CHARS))).toBe('x'.repeat(MAX_TITLE_CHARS))
    expect(clipTitle(smile.repeat(MAX_TITLE_CHARS))).toBe(smile.repeat(MAX_TITLE_CHARS))
  })

  it('puts a title on one line', () => {
    expect(clipTitle('a\nb\r\nc\rd')).toBe('a b c d')
  })

  it('cuts in code points, never inside a surrogate pair', () => {
    expect(clipTitle(`${'x'.repeat(MAX_TITLE_CHARS - 1)}${smile}${smile}`)).toBe(
      `${'x'.repeat(MAX_TITLE_CHARS - 1)}${smile}`,
    )
    // A lone surrogate is one character, as it is once it reaches Rust.
    expect(clipTitle('\ud800'.repeat(MAX_TITLE_CHARS + 1))).toBe('\ud800'.repeat(MAX_TITLE_CHARS))
  })
})

const record = (change: Partial<NoteRecord>): NoteRecord => ({
  id: '0192a6f0-0000-7000-8000-000000000001',
  title: 'Title',
  titleHlc: '0001728000000000-0000-node',
  bodyMd: '',
  ydoc: Uint8Array.of(0, 0),
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
})

const code = (note: NoteRecord, links?: string[]) => {
  try {
    checkNote(note, links)
    return null
  } catch (error) {
    return (error as Error).message
  }
}

describe('checkNote', () => {
  it('counts a title in code points, and refuses a line feed or carriage return as Rust does', () => {
    // Long in UTF-16 units, few characters.
    expect(code(record({ title: `${smile.repeat(MAX_TITLE_CHARS - 1)}x` }))).toBeNull()
    expect(code(record({ title: `${smile.repeat(MAX_TITLE_CHARS)}x` }))).toBe(
      'E_NOTE_TITLE_INVALID',
    )
    expect(code(record({ title: 'a\nb' }))).toBe('E_NOTE_TITLE_INVALID')
    expect(code(record({ title: 'a\rb' }))).toBe('E_NOTE_TITLE_INVALID')
    // A line separator is no line break to a title.
    expect(code(record({ title: `a${String.fromCodePoint(0x2028)}b` }))).toBeNull()
  })

  it('counts a body in UTF-8 bytes', () => {
    expect(code(record({ bodyMd: 'x'.repeat(MAX_BODY_BYTES) }))).toBeNull()
    expect(code(record({ bodyMd: 'x'.repeat(MAX_BODY_BYTES + 1) }))).toBe('E_NOTE_BODY_TOO_LARGE')
  })

  it('counts the links given, or the body’s', () => {
    const body = noteLink('n', '0192a6f0-0000-7000-8000-00000000000a').repeat(20_000)
    // One note linked many times is one link.
    expect(code(record({ bodyMd: body }))).toBeNull()
    expect(code(record({ bodyMd: body }), Array<string>(10_001).fill('x'))).toBe(
      'E_NOTE_LINKS_TOO_MANY',
    )
  })
})
