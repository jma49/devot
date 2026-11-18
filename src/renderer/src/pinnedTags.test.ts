import { describe, expect, it } from 'vitest'
import type { TagRecord } from '../../core/storage'
import { memoryStorage } from '../../../tests/support/local-storage'
import { orderTagsWithPinned, PINNED_TAGS_KEY, readPinnedTags, togglePinnedTag } from './pinnedTags'

const tag = (id: string, name: string): TagRecord => ({
  id,
  name,
  nameHlc: '1',
  color: null,
  colorHlc: '',
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  deletedHlc: null,
})

describe('pinnedTags', () => {
  it('reads and toggles pinned tag IDs in storage cleanly', () => {
    const storage = memoryStorage()
    expect(readPinnedTags(storage)).toEqual([])

    expect(togglePinnedTag('t2', storage)).toEqual(['t2'])
    expect(JSON.parse(storage.getItem(PINNED_TAGS_KEY)!)).toEqual(['t2'])

    expect(togglePinnedTag('t3', storage)).toEqual(['t2', 't3'])
    expect(readPinnedTags(storage)).toEqual(['t2', 't3'])

    expect(togglePinnedTag('t2', storage)).toEqual(['t3'])
    expect(readPinnedTags(storage)).toEqual(['t3'])
  })

  it('recovers gracefully from corrupt or non-string storage values', () => {
    const storage = memoryStorage()
    storage.setItem(PINNED_TAGS_KEY, '{bad json')
    expect(readPinnedTags(storage)).toEqual([])

    storage.setItem(PINNED_TAGS_KEY, JSON.stringify(['t1', 42, null, 't1', 't2']))
    expect(readPinnedTags(storage)).toEqual(['t1', 't2'])
  })

  it('orders pinned tags ahead of unpinned tags while keeping relative order within each group', () => {
    const tags = [tag('t1', 'alpha'), tag('t2', 'beta'), tag('t3', 'gamma'), tag('t4', 'delta')]
    expect(orderTagsWithPinned(tags, new Set(['t3', 't1'])).map((t) => t.id)).toEqual([
      't1',
      't3',
      't2',
      't4',
    ])
  })
})
