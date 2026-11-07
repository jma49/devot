import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../../../../tests/support/local-storage'
import { keptSymbols } from './keptSymbols'

const KEY = 'devot.placedSymbols'
const image = (n: number) => ({ url: `data:image/png;base64,${n}`, side: 16 })

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe('keptSymbols', () => {
  it('saves what was placed once, a moment later, for the same build alone', () => {
    const store = memoryStorage()
    const kept = keptSymbols(() => store as Storage, 'build 1')
    kept.keep('a', image(1))
    kept.keep('b', image(2))
    expect(store.items.has(KEY)).toBe(false)
    vi.runAllTimers()
    expect([...keptSymbols(() => store as Storage, 'build 1').images]).toEqual([
      ['a', image(1)],
      ['b', image(2)],
    ])
    expect(keptSymbols(() => store as Storage, 'build 2').images.size).toBe(0)
  })

  it('keeps the newest 300', () => {
    const store = memoryStorage()
    const kept = keptSymbols(() => store as Storage, 'build')
    for (let n = 0; n < 310; n += 1) kept.keep(`s${n}`, image(n))
    vi.runAllTimers()
    const read = keptSymbols(() => store as Storage, 'build').images
    expect(read.size).toBe(300)
    expect(read.has('s9')).toBe(false)
    expect(read.has('s10')).toBe(true)
  })

  it('reads nothing from what it cannot read, and draws again what it cannot save', () => {
    const store = memoryStorage({ [KEY]: '{not json' })
    expect(keptSymbols(() => store as Storage, 'build').images.size).toBe(0)
    store.items.set(KEY, JSON.stringify({ stamp: 'build', images: [['a', 1, 'x']] }))
    expect(keptSymbols(() => store as Storage, 'build').images.size).toBe(0)
    const full = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    keptSymbols(() => full as unknown as Storage, 'build').keep('a', image(1))
    expect(() => vi.runAllTimers()).not.toThrow()
  })

  it('keeps nothing without a store', () => {
    const kept = keptSymbols(() => undefined, 'build')
    kept.keep('a', image(1))
    expect(() => vi.runAllTimers()).not.toThrow()
  })
})
