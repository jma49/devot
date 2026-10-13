import { describe, expect, it } from 'vitest'
import { buildBookTree, moveTargets, type BookRecord } from './index'

const book = (id: string, name: string, parentId: string | null, sortKey: string): BookRecord => ({
  id,
  name,
  nameHlc: '1',
  parentId,
  parentHlc: '1',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  aiAccess: false,
  aiAccessHlc: '',
  sortKey,
  sortKeyHlc: '1',
})

describe('moveTargets', () => {
  const tree = buildBookTree([
    book('w', 'Work', null, 'a'),
    book('p', 'Projects', 'w', 'a'),
    book('x', 'Plans', 'p', 'a'),
    book('h', 'Home', null, 'b'),
  ])

  it('lists the notebooks in tree order and disables the moved one and its descendants', () => {
    expect(moveTargets(tree, 'w').map((t) => [t.name, t.depth, t.disabled])).toEqual([
      ['Work', 0, true],
      ['Projects', 1, true],
      ['Plans', 2, true],
      ['Home', 0, false],
    ])
  })

  it('leaves the parent and the siblings of a nested notebook enabled', () => {
    expect(moveTargets(tree, 'p').map((t) => [t.id, t.disabled])).toEqual([
      ['w', false],
      ['p', true],
      ['x', true],
      ['h', false],
    ])
  })
})
