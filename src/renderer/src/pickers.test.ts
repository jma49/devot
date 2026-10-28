import { describe, expect, it } from 'vitest'
import type { BookNode } from '../../core/books'
import type { TagRecord } from '../../core/storage'
import { bookOptions, filterBooks, firstBookMatch, NO_BOOK } from './BookPicker'
import { fieldStep, pickerStep } from './Picker'
import { tagRows } from './TagEditor'
import { matchingTags } from './TagPickDialog'
import { SHOW_AFTER_MS, splitTip } from './ToolTips'

function tag(id: string, name: string): TagRecord {
  return {
    id,
    name,
    nameHlc: '',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    deletedHlc: null,
    color: null,
  } as TagRecord
}

function book(id: string, name: string, depth: number, children: BookNode[] = []): BookNode {
  return { id, name, parentId: null, depth, aiAccess: false, children } as unknown as BookNode
}

describe('tagRows', () => {
  const tags = [tag('t1', 'work'), tag('t2', 'homework'), tag('t3', 'ideas')]

  it('lists matching tags (starts first), then a Create row for new text', () => {
    expect(tagRows(tags, [], 'wor')).toEqual([
      { kind: 'tag', tag: tags[0] },
      { kind: 'tag', tag: tags[1] },
      { kind: 'create', name: 'wor' },
    ])
  })

  it('has no Create row when a tag has that name, and leaves out tags on the note', () => {
    expect(tagRows(tags, ['t1'], 'Work')).toEqual([{ kind: 'tag', tag: tags[1] }])
    expect(tagRows(tags, [], '  ')).toEqual([])
  })

  it('has no Create row for a name the core counts as the same, as kana and width variants', () => {
    const same = [tag('k', '\u30bf\u30b0'), tag('f', '\uff34\uff2f\uff24\uff2f'), tag('c', 'café')]
    expect(tagRows(same, [], '\u305f\u3050')).toEqual([])
    expect(tagRows(same, [], 'TODO')).toEqual([])
    expect(tagRows(same, [], 'café')).toEqual([])
  })
})

describe('filterBooks', () => {
  const tree = [
    book('a', 'Work', 0, [book('a1', 'Meetings', 1), book('a2', 'Plans', 1)]),
    book('b', 'Home', 0),
  ]

  it('narrows the tree to the names that match, with the notebooks they sit in', () => {
    const list = bookOptions(tree)
    expect(filterBooks(list, '').map((o) => o.id)).toEqual(['a', 'a1', 'a2', 'b'])
    expect(filterBooks(list, 'meet').map((o) => o.id)).toEqual(['a', 'a1'])
    expect(filterBooks(list, 'HOME').map((o) => o.id)).toEqual(['b'])
    expect(filterBooks(list, 'zzz')).toEqual([])
  })
})

describe('firstBookMatch', () => {
  const noBook = {
    id: NO_BOOK,
    name: 'No Notebook',
    depth: 0,
    ancestors: [],
    icon: null,
    iconColor: null,
  }
  const tree = [book('a', 'Projects', 0, [book('a1', 'Devot', 1)]), book('b', 'Notes', 0)]
  const all = [noBook, ...bookOptions(tree)]

  it('chooses the notebook whose own name matches, not a parent kept as context', () => {
    const left = filterBooks(all, 'devot')
    expect(left.map((o) => o.id)).toEqual(['a', 'a1'])
    expect(firstBookMatch(left, 'devot')?.id).toBe('a1')
  })

  it('does not choose No Notebook just because its name holds the query', () => {
    expect(firstBookMatch(filterBooks(all, 'note'), 'note')?.id).toBe('b')
    // "No Notebook" holds "book" as well as a notebook named Notebooks does.
    const books = [noBook, ...bookOptions([book('n', 'Notebooks', 0)])]
    expect(firstBookMatch(filterBooks(books, 'book'), 'book')?.id).toBe('n')
  })

  it('prefers an exact name, then a name it starts', () => {
    const list = bookOptions([
      book('w', 'Workshop', 0),
      book('x', 'Work', 0),
      book('y', 'Paperwork', 0),
    ])
    expect(firstBookMatch(list, 'work')?.id).toBe('x')
    expect(firstBookMatch(list, 'works')?.id).toBe('w')
    expect(firstBookMatch(list, 'paper')?.id).toBe('y')
    expect(firstBookMatch(list, '')?.id).toBe('w')
  })
})

describe('pickerStep', () => {
  it('moves with Up, Down, Home and End, and stops at the ends', () => {
    expect(pickerStep('ArrowDown', 0, 3)).toBe(1)
    expect(pickerStep('ArrowDown', 2, 3)).toBe(2)
    expect(pickerStep('ArrowUp', 0, 3)).toBe(0)
    expect(pickerStep('Home', 2, 3)).toBe(0)
    expect(pickerStep('End', 0, 3)).toBe(2)
    expect(pickerStep('a', 0, 3)).toBeUndefined()
  })
})

describe('fieldStep', () => {
  it('moves with Up and Down from a typing field, stops at the ends and never wraps', () => {
    expect(fieldStep('ArrowDown', -1, 3)).toBe(0)
    expect(fieldStep('ArrowUp', -1, 3)).toBe(2)
    expect(fieldStep('ArrowDown', 2, 3)).toBe(2)
    expect(fieldStep('ArrowUp', 0, 3)).toBe(0)
    expect(fieldStep('ArrowDown', 0, 3)).toBe(1)
  })

  it('leaves Home and End to the field, and has nothing to move to in an empty list', () => {
    expect(fieldStep('Home', 2, 3)).toBeUndefined()
    expect(fieldStep('End', 0, 3)).toBeUndefined()
    expect(fieldStep('ArrowDown', -1, 0)).toBe(-1)
  })
})

describe('toolbar tooltips', () => {
  it('show after the pointer rests 400 ms (motion.delay.tooltip)', () => {
    expect(SHOW_AFTER_MS).toBe(400)
  })
})

describe('splitTip', () => {
  it('splits a tooltip into the name and its key', () => {
    expect(splitTip('New Note (⌘N)')).toEqual({ name: 'New Note', key: '⌘N' })
    expect(splitTip('More')).toEqual({ name: 'More', key: undefined })
  })
})

describe('matchingTags', () => {
  const tags = [
    tag('k', '\u30bf\u30b0'),
    tag('f', '\uff34\uff2f\uff24\uff2f'),
    tag('c', 'café'),
    tag('x', 'work'),
  ]

  it('lists a tag the core counts as the typed name, though the text differs', () => {
    expect(matchingTags(tags, '\u305f\u3050').map((t) => t.id)).toEqual(['k'])
    expect(matchingTags(tags, 'TODO').map((t) => t.id)).toEqual(['f'])
    expect(matchingTags(tags, 'café').map((t) => t.id)).toEqual(['c'])
    expect(matchingTags(tags, 'wor').map((t) => t.id)).toEqual(['x'])
    expect(matchingTags(tags, '').map((t) => t.id)).toEqual(['k', 'f', 'c', 'x'])
  })
})
