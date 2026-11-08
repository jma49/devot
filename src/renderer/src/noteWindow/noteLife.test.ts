import { describe, expect, it } from 'vitest'
import { nextLife } from './noteLife'

const ID = '0192a6f0-0000-7000-8000-000000000001'
const trashed = { kind: 'gone', noteId: ID, purged: false } as const
const purged = { kind: 'gone', noteId: ID, purged: true } as const
const back = { kind: 'back', noteId: ID } as const

describe('a note window’s note', () => {
  it('turns read-only in the Trash and editable again when it is put back', () => {
    expect(nextLife('live', trashed)).toBe('trashed')
    expect(nextLife('trashed', back)).toBe('live')
    expect(nextLife('live', back)).toBe('live')
  })

  it('stays read-only for good once it is purged', () => {
    expect(nextLife('live', purged)).toBe('purged')
    expect(nextLife('trashed', purged)).toBe('purged')
    expect(nextLife('purged', back)).toBe('purged')
    expect(nextLife('purged', trashed)).toBe('purged')
  })
})
