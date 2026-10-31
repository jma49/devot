import { describe, expect, it } from 'vitest'
import type { BookNode } from '../../core/books'
import { aiAccessChanges, checkedNotebooks, inverseChanges, notebooksInOrder } from './aiAccess'

const node = (
  id: string,
  aiAccess: boolean,
  depth = 0,
  children: BookNode[] = [],
  parentId: string | null = null,
): BookNode => ({
  id,
  name: id,
  parentId,
  depth,
  aiAccess,
  icon: null,
  iconColor: null,
  children,
})

const tree = [
  node('work', false, 0, [
    node('work/projects', true, 1, [], 'work'),
    node('work/ideas', false, 1, [], 'work'),
  ]),
  node('home', false),
  node('archive', true, 0, [node('archive/old', false, 1, [], 'archive')]),
]

describe('notebooksInOrder', () => {
  it('lists each notebook once, depth first', () => {
    expect(notebooksInOrder(tree).map((n) => n.id)).toEqual([
      'work',
      'work/projects',
      'work/ideas',
      'home',
      'archive',
      'archive/old',
    ])
  })
})

describe('checkedNotebooks', () => {
  it('starts from the notebooks that allow AI access now', () => {
    expect([...checkedNotebooks(tree)].sort()).toEqual(['archive', 'work/projects'])
  })
})

describe('aiAccessChanges', () => {
  it('changes only the notebooks whose switch differs, in tree order', () => {
    const checked = checkedNotebooks(tree)
    expect(aiAccessChanges(tree, checked)).toEqual([])
    checked.add('home')
    checked.delete('archive')
    expect(aiAccessChanges(tree, checked)).toEqual([
      { id: 'home', on: true },
      { id: 'archive', on: false },
    ])
  })

  it('keeps a parent and its sub-notebooks independent', () => {
    const checked = new Set(['work', 'work/projects', 'archive'])
    expect(aiAccessChanges(tree, checked)).toEqual([{ id: 'work', on: true }])
  })
})

describe('inverseChanges', () => {
  it('takes back every change', () => {
    const changes = [
      { id: 'work', on: true },
      { id: 'archive', on: false },
    ]
    expect(inverseChanges(changes)).toEqual([
      { id: 'work', on: false },
      { id: 'archive', on: true },
    ])
  })
})
