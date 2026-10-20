import { describe, expect, it } from 'vitest'
import { rowScrollBehavior } from './listScroll'

describe('rowScrollBehavior', () => {
  it('scrolls smoothly for a single step', () => {
    expect(rowScrollBehavior(false, false)).toBe('smooth')
  })

  it('jumps while a key repeats or when animations are off', () => {
    expect(rowScrollBehavior(false, true)).toBe('auto')
    expect(rowScrollBehavior(true, false)).toBe('auto')
  })
})
