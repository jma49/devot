import { describe, expect, it } from 'vitest'
import type { Core } from '../core-client'
import { pluginNotes } from './notes'

const summary = {
  id: 'n1',
  title: 'Plan',
  createdAt: 1,
  updatedAt: 2,
  bodyVersion: 1,
  bookId: 'b1',
  status: 'active',
  pinned: true,
  tagIds: ['t1', 'gone', 't2'],
}

const core = {
  list: async () => [summary],
  search: async () => ({ found: [summary] }),
  listTags: async () => [
    { id: 't1', name: 'work', deletedAt: null },
    { id: 't2', name: 'later', deletedAt: null },
    { id: 'gone', name: 'old', deletedAt: 5 },
  ],
  read: async (id: string) => ({
    id,
    title: 'Plan',
    bookId: 'b1',
    bodyMd: '---\nrating: 4\ndue: 2026-12-01\ntags: [a, b]\n---\n# Plan\n',
  }),
} as unknown as Core

describe('the notes a plugin with notes.read sees (ADR 0028)', () => {
  it('names the tags of a note, its status and whether it is pinned', async () => {
    const notes = pluginNotes(() => core)
    const expected = {
      id: 'n1',
      title: 'Plan',
      notebook: 'b1',
      createdAt: 1,
      updatedAt: 2,
      tags: ['work', 'later'],
      status: 'active',
      pinned: true,
    }
    expect(await notes.list(10)).toEqual([expected])
    expect(await notes.search('plan', 10)).toEqual([expected])
  })

  it('reads a note with its front matter as properties', async () => {
    expect((await pluginNotes(() => core).get('n1')).properties).toEqual({
      rating: 4,
      due: '2026-12-01',
      tags: ['a', 'b'],
    })
  })
})
