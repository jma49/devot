import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isSortKey, keyBetween, MAX_SORT_KEY_LENGTH, sequentialKeys } from './order'

describe('keyBetween', () => {
  it('starts at a0 and counts up and down from there', () => {
    expect(keyBetween(null, null)).toBe('a0')
    expect(keyBetween('a0', null)).toBe('a1')
    expect(keyBetween('a9', null)).toBe('aA')
    expect(keyBetween('az', null)).toBe('b00')
    expect(keyBetween('bzz', null)).toBe('c000')
    expect(keyBetween(null, 'a0')).toBe('Zz')
    expect(keyBetween(null, 'Zz')).toBe('Zy')
    expect(keyBetween(null, 'Z0')).toBe('Yzz')
  })

  it('finds a key strictly between two keys', () => {
    expect(keyBetween('a0', 'a1')).toBe('a0V')
    expect(keyBetween('a0', 'a2')).toBe('a1')
    expect(keyBetween('a0V', 'a1')).toBe('a0l')
    expect(keyBetween('a1', 'a1V')).toBe('a1G')
    expect(keyBetween('az', 'b00')).toBe('azV')
  })

  it('refuses keys out of order or malformed', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow('E_SORT_KEY_ORDER')
    expect(() => keyBetween('a1', 'a1')).toThrow('E_SORT_KEY_ORDER')
    for (const bad of ['', 'a', 'a00', 'a0 ', '!0', 'b0', 'A00000000000000000000000000']) {
      expect(() => keyBetween(bad, null)).toThrow('E_SORT_KEY_INVALID')
      expect(() => keyBetween(null, bad)).toThrow('E_SORT_KEY_INVALID')
    }
  })

  it('keeps every key between its neighbours, however often a gap is split', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(), fc.boolean()), { minLength: 1, maxLength: 200 }),
        (steps) => {
          const keys: string[] = []
          for (const [at, end] of steps) {
            const i = end ? keys.length : at % (keys.length + 1)
            const key = keyBetween(keys[i - 1] ?? null, keys[i] ?? null)
            expect(isSortKey(key)).toBe(true)
            keys.splice(i, 0, key)
          }
          const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          expect(keys).toEqual(sorted)
          expect(new Set(keys).size).toBe(keys.length)
        },
      ),
    )
  })

  it('grows slowly when the same gap is split again and again', () => {
    let lo = 'a0'
    const hi = 'a1'
    for (let i = 0; i < 1000; i += 1) lo = keyBetween(lo, hi)
    expect(lo.length).toBeLessThan(MAX_SORT_KEY_LENGTH)
  })
})

describe('isSortKey', () => {
  it('accepts generated keys and refuses everything else', () => {
    for (const key of [
      'a0',
      'Zz',
      'a0V',
      'b00',
      'z'.repeat(27),
      'a0' + 'V'.repeat(MAX_SORT_KEY_LENGTH - 2),
    ])
      expect(isSortKey(key)).toBe(true)
    for (const key of [
      '',
      'a',
      'a0 ',
      'a00',
      'a10',
      'b0',
      '0a',
      'a0' + 'V'.repeat(MAX_SORT_KEY_LENGTH - 1),
    ])
      expect(isSortKey(key)).toBe(false)
  })
})

describe('sequentialKeys', () => {
  it('is the chain of keys after one another from a0', () => {
    const keys = sequentialKeys(4000)
    let previous: string | null = null
    for (const key of keys) {
      expect(key).toBe(keyBetween(previous, null))
      previous = key
    }
    expect(keys.slice(0, 3)).toEqual(['a0', 'a1', 'a2'])
    expect(keys[62]).toBe('b00')
    expect(sequentialKeys(0)).toEqual([])
  })
})
