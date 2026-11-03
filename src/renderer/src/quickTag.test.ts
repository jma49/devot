import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagRecord } from '../../core/storage'
import { quickTagRows, readRecentTags, rememberTag } from './quickTag'

const tag = (id: string, name: string): TagRecord => ({
  id,
  name,
  nameHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
  color: null,
  colorHlc: '',
})
const TAGS = [tag('a', 'alpha'), tag('b', 'beta'), tag('c', 'gamma'), tag('d', '\u4e2d\u6587')]

const names = (rows: ReturnType<typeof quickTagRows>) =>
  rows.map((r) => (r.kind === 'tag' ? r.tag.name : `+${r.name}`))

function memoryStore() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

beforeEach(() => {
  vi.stubGlobal('navigator', { languages: ['en'] })
})

describe('quickTagRows', () => {
  it('lists recent tags first when empty, without those on the note', () => {
    expect(names(quickTagRows(TAGS, ['a'], '', ['c', 'a']))).toEqual([
      'gamma',
      'beta',
      '\u4e2d\u6587',
    ])
  })

  it('ignores a recent tag that no longer exists', () => {
    expect(names(quickTagRows(TAGS, [], '', ['gone', 'b']))[0]).toBe('beta')
  })

  it('filters by the text, and offers to create a new name', () => {
    expect(names(quickTagRows(TAGS, [], 'al', []))).toEqual(['alpha', '+al'])
    expect(names(quickTagRows(TAGS, [], 'ALPHA', []))).toEqual(['alpha'])
  })

  it('finds and creates CJK names', () => {
    expect(names(quickTagRows(TAGS, [], '\u4e2d', []))).toEqual(['\u4e2d\u6587', '+\u4e2d'])
  })

  it('offers nothing to create for a name already on the note', () => {
    expect(names(quickTagRows(TAGS, ['a'], 'alpha', []))).toEqual([])
  })
})

describe('recent tags', () => {
  it('keeps the newest first, each once, up to eight', () => {
    const store = memoryStore()
    for (const id of ['1', '2', '3', '1', '4', '5', '6', '7', '8', '9']) rememberTag(store, id)
    expect(readRecentTags(store)).toEqual(['9', '8', '7', '6', '5', '4', '1', '3'])
  })

  it('reads a damaged store as none', () => {
    const store = memoryStore()
    store.setItem('devot.tags.recent', '{broken')
    expect(readRecentTags(store)).toEqual([])
    expect(readRecentTags(undefined)).toEqual([])
  })
})
