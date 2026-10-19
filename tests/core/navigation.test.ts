import { describe, expect, it } from 'vitest'
import {
  EMPTY_TRAIL,
  TRAIL_LIMIT,
  adjacentNote,
  stepTarget,
  trailTo,
  visit,
  type Trail,
} from '../../src/core/navigation'

const trailOf = (...ids: string[]): Trail =>
  ids.reduce((trail, id) => visit(trail, id), EMPTY_TRAIL)
const everyNote = () => true

describe('visit', () => {
  it('adds each note opened after the current one', () => {
    expect(trailOf('a', 'b', 'c')).toEqual({ ids: ['a', 'b', 'c'], at: 2 })
  })

  it('keeps one entry when the open note opens again', () => {
    expect(trailOf('a', 'b', 'b')).toEqual({ ids: ['a', 'b'], at: 1 })
  })

  it('drops the entries ahead when a note opens after going back', () => {
    const back = trailTo(trailOf('a', 'b', 'c'), 0)
    expect(visit(back, 'd')).toEqual({ ids: ['a', 'd'], at: 1 })
  })

  it('keeps the latest entries up to the limit', () => {
    const ids = Array.from({ length: TRAIL_LIMIT + 5 }, (_, i) => `n${i}`)
    const trail = trailOf(...ids)
    expect(trail.ids).toHaveLength(TRAIL_LIMIT)
    expect(trail.ids[0]).toBe('n5')
    expect(trail.at).toBe(TRAIL_LIMIT - 1)
  })
})

describe('stepTarget', () => {
  it('goes back and forward one entry at a time', () => {
    const trail = trailOf('a', 'b', 'c')
    expect(stepTarget(trail, -1, { live: everyNote, current: 'c' })).toBe(1)
    expect(stepTarget(trail, 1, { live: everyNote, current: 'c' })).toBeUndefined()
    const back = trailTo(trail, 1)
    expect(stepTarget(back, -1, { live: everyNote, current: 'b' })).toBe(0)
    expect(stepTarget(back, 1, { live: everyNote, current: 'b' })).toBe(2)
  })

  it('has nowhere to go at either end, or with no entries', () => {
    expect(stepTarget(trailOf('a'), -1, { live: everyNote, current: 'a' })).toBeUndefined()
    expect(stepTarget(trailOf('a'), 1, { live: everyNote, current: 'a' })).toBeUndefined()
    expect(stepTarget(EMPTY_TRAIL, -1, { live: everyNote, current: undefined })).toBeUndefined()
    expect(stepTarget(EMPTY_TRAIL, 1, { live: everyNote, current: undefined })).toBeUndefined()
  })

  it('skips notes that are deleted', () => {
    const trail = trailOf('a', 'b', 'c', 'd')
    const live = (id: string) => id !== 'b' && id !== 'c'
    expect(stepTarget(trail, -1, { live, current: 'd' })).toBe(0)
    expect(stepTarget(trailTo(trail, 0), 1, { live, current: 'a' })).toBe(3)
    expect(stepTarget(trail, -1, { live: (id) => id === 'd', current: 'd' })).toBeUndefined()
  })

  it('skips entries for the note that is open', () => {
    // a, b, a: after b is deleted, back from the second a has nowhere new to go.
    const trail = trailOf('a', 'b', 'a')
    expect(stepTarget(trail, -1, { live: (id) => id !== 'b', current: 'a' })).toBeUndefined()
  })

  it('goes back to the current entry when another note is shown (the Trash)', () => {
    const trail = trailOf('a', 'b')
    expect(stepTarget(trail, -1, { live: everyNote, current: undefined })).toBe(1)
    expect(stepTarget(trail, -1, { live: everyNote, current: 'x' })).toBe(1)
    expect(stepTarget(trailTo(trail, 0), 1, { live: everyNote, current: undefined })).toBe(1)
    expect(stepTarget(trail, -1, { live: (id) => id !== 'b', current: undefined })).toBe(0)
  })
})

describe('trailTo', () => {
  it('moves the cursor and keeps the entries', () => {
    expect(trailTo(trailOf('a', 'b', 'c'), 0)).toEqual({ ids: ['a', 'b', 'c'], at: 0 })
  })
})

describe('adjacentNote', () => {
  const ids = ['a', 'b', 'c']

  it('gives the next and the previous note in the list', () => {
    expect(adjacentNote(ids, 'b', 1)).toBe('c')
    expect(adjacentNote(ids, 'b', -1)).toBe('a')
  })

  it('stops at the ends', () => {
    expect(adjacentNote(ids, 'c', 1)).toBeUndefined()
    expect(adjacentNote(ids, 'a', -1)).toBeUndefined()
  })

  it('starts from the first or the last note when the open note is not listed', () => {
    expect(adjacentNote(ids, undefined, 1)).toBe('a')
    expect(adjacentNote(ids, undefined, -1)).toBe('c')
    expect(adjacentNote(ids, 'elsewhere', 1)).toBe('a')
    expect(adjacentNote(ids, 'elsewhere', -1)).toBe('c')
    expect(adjacentNote([], undefined, 1)).toBeUndefined()
  })
})
