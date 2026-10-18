import { describe, expect, it } from 'vitest'
import type { BookNode } from '../../core/books'
import {
  choicesFromTree,
  notebookForNewNote,
  publishNotebooks,
  readNotebooks,
} from './notebookChoices'

function memory() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

const node = (id: string, depth: number, children: BookNode[] = []): BookNode => ({
  id,
  name: `Book ${id}`,
  parentId: null,
  depth,
  aiAccess: false,
  icon: null,
  iconColor: null,
  children,
})

describe('notebook choices', () => {
  it('lists the notebooks with sub-notebooks under their parent', () => {
    const tree = [node('a', 0, [node('a1', 1)]), node('b', 0)]
    expect(choicesFromTree(tree).map((c) => [c.id, c.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['b', 0],
    ])
  })

  it('goes from one window to the other through storage', () => {
    const storage = memory()
    expect(readNotebooks(storage)).toEqual([])
    publishNotebooks([{ id: 'a', name: 'Work', depth: 0 }], storage)
    expect(readNotebooks(storage)).toEqual([{ id: 'a', name: 'Work', depth: 0 }])
    // What is not a notebook, or not even JSON, is left out.
    storage.setItem('devot.notebookChoices', '[1, {"id": "b"}, {"id":"c","name":"N","depth":1}]')
    expect(readNotebooks(storage)).toEqual([{ id: 'c', name: 'N', depth: 1 }])
    storage.setItem('devot.notebookChoices', '{ not json')
    expect(readNotebooks(storage)).toEqual([])
    expect(() => publishNotebooks([], undefined)).not.toThrow()
  })
})

describe('the notebook for a new note', () => {
  it('is the notebook of the view, else the default notebook, else none', () => {
    expect(notebookForNewNote('view', 'def', ['view', 'def'])).toBe('view')
    expect(notebookForNewNote(undefined, 'def', ['def'])).toBe('def')
    expect(notebookForNewNote(null, 'def', ['def'])).toBe('def')
    expect(notebookForNewNote(undefined, null, ['def'])).toBeNull()
    // A default notebook that was deleted since is no notebook.
    expect(notebookForNewNote(undefined, 'gone', ['def'])).toBeNull()
  })
})
