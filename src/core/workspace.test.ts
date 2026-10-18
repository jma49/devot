import { describe, expect, it } from 'vitest'
import {
  bookCounts,
  buildBookTree,
  findBookNode,
  notesInBook,
  statusCounts,
  tagCounts,
  workspaceParent,
  workspaceParents,
  workspaceTree,
  type BookNode,
  type BookRecord,
  type NoteStatus,
  type NoteSummary,
} from './index'

const book = (id: string, parentId: string | null, sortKey = 'a'): BookRecord => ({
  id,
  name: id.toUpperCase(),
  nameHlc: '1',
  parentId,
  parentHlc: '1',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  aiAccess: false,
  aiAccessHlc: '',
  icon: null,
  iconColor: null,
  iconHlc: '',
  sortKey,
  sortKeyHlc: '1',
})

const note = (
  id: string,
  bookId: string | null,
  status: NoteStatus = 'none',
  tagIds: string[] = [],
): NoteSummary => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  bookId,
  status,
  pinned: false,
  tagIds,
})

// Work > Projects > Plans, Work > Ideas, and Home.
const books = [
  book('work', null, 'a'),
  book('projects', 'work', 'a'),
  book('plans', 'projects', 'a'),
  book('ideas', 'work', 'b'),
  book('home', null, 'b'),
]
const tree = buildBookTree(books)
const shape = (nodes: BookNode[]): unknown[] =>
  nodes.map((n) => [n.id, n.depth, ...(n.children.length ? [shape(n.children)] : [])])

describe('workspace notebooks', () => {
  it('finds a notebook anywhere in the tree', () => {
    expect(findBookNode(tree, 'plans')?.name).toBe('PLANS')
    expect(findBookNode(tree, 'gone')).toBeUndefined()
  })

  it('lists the sub-notebooks with depths counted from the workspace', () => {
    expect(shape(workspaceTree(tree, 'work'))).toEqual([
      ['projects', 0, [['plans', 1]]],
      ['ideas', 0],
    ])
    expect(shape(workspaceTree(tree, 'projects'))).toEqual([['plans', 0]])
    expect(workspaceTree(tree, 'plans')).toEqual([])
  })

  it('leaves the tree itself as it was', () => {
    workspaceTree(tree, 'work')
    expect(findBookNode(tree, 'plans')?.depth).toBe(2)
  })

  it('has no sub-notebooks for a notebook that is gone', () => {
    expect(workspaceTree(tree, 'gone')).toEqual([])
  })

  it('names the parents, the top-level one first', () => {
    expect(workspaceParents(tree, 'plans').map((n) => n.id)).toEqual(['work', 'projects'])
    expect(workspaceParents(tree, 'work')).toEqual([])
    expect(workspaceParents(tree, 'gone')).toEqual([])
  })

  it('goes up to the parent, and out of workspaces from the top level', () => {
    expect(workspaceParent(tree, 'plans')).toBe('projects')
    expect(workspaceParent(tree, 'projects')).toBe('work')
    expect(workspaceParent(tree, 'work')).toBeNull()
    expect(workspaceParent(tree, 'gone')).toBeNull()
  })
})

describe('workspace counts', () => {
  const notes = [
    note('a', 'work', 'active', ['t1']),
    note('b', 'plans', 'active', ['t2']),
    note('c', 'ideas', 'completed'),
    note('d', 'home', 'active', ['t1', 't3']),
    note('e', null, 'on_hold'),
  ]

  it('holds the notes of the notebook and its sub-notebooks only', () => {
    expect(notesInBook(notes, books, 'work').map((n) => n.id)).toEqual(['a', 'b', 'c'])
    expect(notesInBook(notes, books, 'projects').map((n) => n.id)).toEqual(['b'])
  })

  it('counts statuses and tags over the workspace notes', () => {
    const inWork = notesInBook(notes, books, 'work')
    expect(Object.fromEntries(statusCounts(inWork))).toEqual({ active: 2, completed: 1 })
    expect(Object.fromEntries(tagCounts(inWork))).toEqual({ t1: 1, t2: 1 })
    // A notebook count keeps its sub-notebooks' notes, inside a workspace too.
    expect(bookCounts(inWork, books).get('projects')).toBe(1)
    expect(bookCounts(inWork, books).get('work')).toBe(3)
  })
})
