import { describe, expect, it } from 'vitest'
import { DB_CHANGED, dbChanged, loadedAny, NOTES_LOADED, widened } from './externalChanges'

const loaded = (detail?: readonly string[]) => new CustomEvent(NOTES_LOADED, { detail })

describe('widened', () => {
  it('gathers the notes the writes named', () => {
    const first = widened(undefined, dbChanged(['a']))
    expect(first).toEqual(new Set(['a']))
    expect(widened(first, dbChanged(['b']))).toEqual(new Set(['a', 'b']))
  })

  it('takes everything once any write does not name its notes', () => {
    expect(widened(new Set(['a']), dbChanged())).toBe('all')
    expect(widened('all', dbChanged(['b']))).toBe('all')
    expect(widened(undefined, new CustomEvent(DB_CHANGED, { detail: { notes: 'a' } }))).toBe('all')
  })
})

describe('loadedAny', () => {
  it('hears a reload of any of the notes, or one that names none', () => {
    expect(loadedAny(loaded(['a', 'b']), ['b', 'c'])).toBe(true)
    expect(loadedAny(loaded(['a']), ['c'])).toBe(false)
    expect(loadedAny(loaded([]), ['c'])).toBe(false)
    expect(loadedAny(loaded(), ['c'])).toBe(true)
  })
})
