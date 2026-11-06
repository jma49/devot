import { describe, expect, it } from 'vitest'
import type { BookNode } from '../../../core/books'
import {
  filterRowOf,
  libraryRow,
  neighbours,
  sameFilter,
  searchRow,
  subtree,
  visibleRows,
} from './model'

const node = (id: string, children: BookNode[] = [], depth = 0): BookNode => ({
  id,
  name: id,
  parentId: null,
  depth,
  aiAccess: false,
  icon: null,
  iconColor: null,
  children,
})

const tree = [node('a', [node('a1', [], 1), node('a2', [node('a2x', [], 2)], 1)]), node('b')]

describe('sidebar rows', () => {
  it('lists the notebooks shown, skipping the children of collapsed ones', () => {
    expect(visibleRows(tree, new Set()).map((n) => n.id)).toEqual(['a', 'a1', 'a2', 'a2x', 'b'])
    expect(visibleRows(tree, new Set(['a'])).map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('finds each notebook its siblings either side', () => {
    const around = neighbours(tree)
    expect(around.get('a')).toEqual({ previousId: null, nextId: 'b' })
    expect(around.get('a2')).toEqual({ previousId: 'a1', nextId: null })
    expect(around.get('a2x')).toEqual({ previousId: null, nextId: null })
  })

  it('takes a notebook with every sub-notebook under it', () => {
    expect([...subtree(tree, 'a')].sort()).toEqual(['a', 'a1', 'a2', 'a2x'])
    expect([...subtree(tree, 'missing')]).toEqual([])
  })

  it('keys each row by what it shows', () => {
    expect(libraryRow({ kind: 'book', id: 'a' }).key).toBe('book:a')
    expect(libraryRow({ kind: 'trash' }).key).toBe('trash')
    expect(searchRow('s1').key).toBe('search:s1')
    expect(filterRowOf({ kind: 'pinned' }).key).toBe('pinned')
    expect(filterRowOf({ kind: 'status', status: 'active' }).key).toBe('status:active')
    expect(filterRowOf({ kind: 'tag', tagId: 't1' }).key).toBe('tag:t1')
  })

  it('compares filters by what they keep', () => {
    expect(sameFilter(null, { kind: 'pinned' })).toBe(false)
    expect(sameFilter({ kind: 'tag', tagId: 't1' }, { kind: 'tag', tagId: 't1' })).toBe(true)
    expect(sameFilter({ kind: 'tag', tagId: 't1' }, { kind: 'tag', tagId: 't2' })).toBe(false)
    expect(
      sameFilter({ kind: 'status', status: 'active' }, { kind: 'status', status: 'dropped' }),
    ).toBe(false)
  })
})
