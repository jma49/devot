import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../../core'
import type { BookNode } from '../../../core/books'
import { commandEntries, libraryEntries } from './entries'

const node = (id: string, name: string, children: BookNode[] = [], depth = 0): BookNode => ({
  id,
  name,
  parentId: null,
  depth,
  aiAccess: false,
  children,
})

const note = (
  id: string,
  title: string,
  updatedAt: number,
  bookId: string | null,
): NoteSummary => ({
  id,
  title,
  createdAt: 0,
  updatedAt,
  bookId,
  status: 'none',
  pinned: false,
  tagIds: [],
})

describe('libraryEntries', () => {
  const tree = [node('w', 'Work', [node('p', 'Projects', [], 1)]), node('h', 'Home')]
  const entries = libraryEntries({
    tree,
    tags: [{ id: 't', name: 'urgent' }],
    notes: [
      note('a', 'Old', 1, 'p'),
      note('b', '', 3, null),
      note('c', 'In a deleted notebook', 2, 'gone'),
    ],
    untitled: 'Untitled',
  })

  it('lists notebooks in tree order, each with its parent', () => {
    expect(entries.book).toEqual([
      { kind: 'book', id: 'w', label: 'Work' },
      { kind: 'book', id: 'p', label: 'Projects', detail: 'Work' },
      { kind: 'book', id: 'h', label: 'Home' },
    ])
  })

  it('lists notes newest first, with their notebook, untitled ones by that name', () => {
    expect(entries.note).toEqual([
      { kind: 'note', id: 'b', label: 'Untitled' },
      { kind: 'note', id: 'c', label: 'In a deleted notebook' },
      { kind: 'note', id: 'a', label: 'Old', detail: 'Projects' },
    ])
  })

  it('lists tags by name', () => {
    expect(entries.tag).toEqual([{ kind: 'tag', id: 't', label: 'urgent' }])
  })
})

describe('commandEntries', () => {
  it('lists the commands the window can run, with their key, never the palette', () => {
    const run = () => {}
    const list = commandEntries(
      {
        'palette.open': { run },
        'view.focus': { run },
        'note.pin': { run, label: 'note.unpin' },
        'note.copyId': { run },
      },
      (key) => `<${key}>`,
    )
    expect(list).toEqual([
      { kind: 'command', id: 'note.pin', label: '<note.unpin>', shortcut: 'P' },
      { kind: 'command', id: 'note.copyId', label: '<noteMenu.copyId>' },
      { kind: 'command', id: 'view.focus', label: '<mode.focus>', shortcut: '\u21e7\u2318D' },
    ])
  })
})
