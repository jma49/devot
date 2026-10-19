import { describe, expect, it } from 'vitest'
import { firstImported, openDestination } from './cliOpen'

const books = [
  { id: 'b1', name: 'Work' },
  { id: 'b2', name: 'work' },
  { id: 'b3', name: 'Projects' },
  { id: 'b4', name: 'Inbox' },
]

describe('where handed-over files go', () => {
  it('goes into the notebook of that name, exactly first, else in any case', () => {
    expect(openDestination('work', books, null)).toEqual({ kind: 'book', id: 'b2' })
    expect(openDestination('Work', books, null)).toEqual({ kind: 'book', id: 'b1' })
    expect(openDestination('PROJECTS', books, null)).toEqual({ kind: 'book', id: 'b3' })
  })

  it('makes the notebook named when there is none', () => {
    expect(openDestination('Reading', books, 'b4')).toEqual({ kind: 'create', name: 'Reading' })
  })

  it('goes into the default notebook without a name, while it exists', () => {
    expect(openDestination(null, books, 'b4')).toEqual({ kind: 'book', id: 'b4' })
    expect(openDestination(null, books, 'gone')).toEqual({ kind: 'book', id: null })
    expect(openDestination(null, books, null)).toEqual({ kind: 'book', id: null })
  })
})

describe('the note opened afterwards', () => {
  const files = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }]

  it('is the first file named', () => {
    expect(firstImported({ 'a.md': 'n1', 'c.md': 'n3' }, files, 'c.md')).toBe('n3')
  })

  it('is the first imported when the first named was not', () => {
    expect(firstImported({ 'b.md': 'n2', 'c.md': 'n3' }, files, 'a.md')).toBe('n2')
    expect(firstImported({ 'c.md': 'n3' }, files, null)).toBe('n3')
    expect(firstImported({}, files, 'a.md')).toBeUndefined()
  })
})
