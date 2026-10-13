import { describe, expect, it } from 'vitest'
import { rowCandidates } from './focusRescue'

const ORDER = [
  'all',
  'pinned',
  'book:a',
  'book:b',
  'book:c',
  'status:active',
  'tag:x',
  'tag:y',
  'templates',
  'trash',
]

describe('rowCandidates', () => {
  it('tries the row itself first: it may only have moved or been renamed', () => {
    expect(rowCandidates(ORDER, 'book:b')[0]).toBe('book:b')
  })

  it('then the rows of its own kind after it, then before it, nearest first', () => {
    expect(rowCandidates(ORDER, 'book:b').slice(0, 3)).toEqual(['book:b', 'book:c', 'book:a'])
    expect(rowCandidates(ORDER, 'tag:y').slice(0, 2)).toEqual(['tag:y', 'tag:x'])
  })

  it('then the other rows, those after it before those above', () => {
    expect(rowCandidates(ORDER, 'book:c')).toEqual([
      'book:c',
      'book:b',
      'book:a',
      'status:active',
      'tag:x',
      'tag:y',
      'templates',
      'trash',
      'pinned',
      'all',
    ])
  })

  it('offers every row when the row was never seen', () => {
    expect(rowCandidates(ORDER, 'book:gone')).toEqual(ORDER)
  })
})
