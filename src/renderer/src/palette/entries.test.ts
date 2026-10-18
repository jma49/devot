import { describe, expect, it } from 'vitest'
import type { NoteSummary } from '../../../core'
import type { BookNode } from '../../../core/books'
import { commandEntries, libraryEntries, outlineEntries, withTagClause } from './entries'

const node = (id: string, name: string, children: BookNode[] = [], depth = 0): BookNode => ({
  id,
  name,
  parentId: null,
  depth,
  aiAccess: false,
  icon: null,
  iconColor: null,
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
  const projects = { ...node('p', 'Projects', [], 1), icon: 'leaf', iconColor: 'green' as const }
  const tree = [node('w', 'Work', [projects]), node('h', 'Home')]
  const entries = libraryEntries({
    tree,
    tags: [{ id: 't', name: 'urgent' }],
    notes: [
      note('a', 'Old', 1, 'p'),
      note('b', '', 3, null),
      note('c', 'In a deleted notebook', 2, 'gone'),
    ],
    headlines: new Map([
      ['b', 'Groceries'],
      ['z', 'Unused'],
    ]),
  })

  it('lists notebooks in tree order, each with its parent and its icon', () => {
    const none = { icon: null, color: null }
    expect(entries.book).toEqual([
      { kind: 'book', id: 'w', label: 'Work', bookIcon: none },
      {
        kind: 'book',
        id: 'p',
        label: 'Projects',
        detail: 'Work',
        bookIcon: { icon: 'leaf', color: 'green' },
      },
      { kind: 'book', id: 'h', label: 'Home', bookIcon: none },
    ])
  })

  it('lists notes newest first, with their notebook, untitled ones by their first line', () => {
    expect(entries.note).toEqual([
      { kind: 'note', id: 'b', label: 'Groceries' },
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
      {
        kind: 'command',
        id: 'note.pin',
        label: '<note.unpin>',
        description: '<palette.group.note>',
        shortcut: 'P',
      },
      {
        kind: 'command',
        id: 'note.copyId',
        label: '<noteMenu.copyId>',
        description: '<palette.group.note>',
      },
      {
        kind: 'command',
        id: 'view.focus',
        label: '<mode.focus>',
        description: '<palette.group.view>',
        shortcut: '\u21e7\u2318D',
      },
    ])
  })
})

describe('outlineEntries', () => {
  const doc = [
    '---',
    '# not a heading',
    '---',
    '# Title',
    '',
    '- [ ] first',
    '## Part',
    '```',
    '# in code',
    '- [ ] in code',
    '```',
    '- [x] done',
    '  - [ ] nested',
    '### Deep ###',
    'text',
    '#NoSpace',
  ].join('\n')

  it('lists headings and tasks in document order, with their levels and lines', () => {
    expect(
      outlineEntries(doc).map((e) => [e.label, e.line, e.level, e.depth, e.done ?? null]),
    ).toEqual([
      ['Title', 4, 1, 0, null],
      ['first', 6, 0, 1, false],
      ['Part', 7, 2, 1, null],
      ['done', 12, 0, 2, true],
      ['nested', 13, 0, 3, false],
      ['Deep', 14, 3, 2, null],
    ])
  })

  it('is empty for a note without headings or tasks', () => {
    expect(outlineEntries('just text\n\nmore')).toEqual([])
  })
})

describe('withTagClause', () => {
  it('adds a tag clause once, quoting names with spaces', () => {
    expect(withTagClause('', 'urgent')).toBe('tag:urgent ')
    expect(withTagClause('milk', 'deep focus')).toBe('milk tag:"deep focus" ')
    expect(withTagClause('tag:urgent ', 'urgent')).toBe('tag:urgent ')
  })
})
