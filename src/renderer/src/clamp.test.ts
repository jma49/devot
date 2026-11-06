import { describe, expect, it } from 'vitest'
import { clamp } from './clamp'

describe('clamp', () => {
  it('keeps a value within its bounds', () => {
    expect(clamp(-1, 0, 1)).toBe(0)
    expect(clamp(0.5, 0, 1)).toBe(0.5)
    expect(clamp(2, 0, 1)).toBe(1)
  })

  it('gives the upper bound when the bounds cross', () => {
    expect(clamp(3, 0, -1)).toBe(-1)
  })
})
