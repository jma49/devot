import { describe, expect, it } from 'vitest'
import { notebookPath } from './library'

describe('notebookPath', () => {
  const books = [
    { id: 'a', name: 'Projects', parentId: null },
    { id: 'b', name: 'Devot', parentId: 'a' },
    { id: 'x', name: 'Loop', parentId: 'y' },
    { id: 'y', name: 'Back', parentId: 'x' },
  ]
  it('names the path from the top', () => {
    expect(notebookPath(books, 'b')).toBe('Projects / Devot')
  })
  it('is empty without a notebook', () => {
    expect(notebookPath(books, null)).toBe('')
    expect(notebookPath(books, 'gone')).toBe('')
  })
  it('stops at a cycle', () => {
    expect(notebookPath(books, 'x')).toBe('Back / Loop')
  })
})
