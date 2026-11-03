import { describe, expect, it } from 'vitest'
import { outlineFits } from './room'

describe('the outline column', () => {
  it('needs the panes’ least width and its own', () => {
    expect(outlineFits(460, 'edit', 240, 220)).toBe(true)
    expect(outlineFits(459, 'edit', 240, 220)).toBe(false)
    expect(outlineFits(699, 'split', 240, 220)).toBe(false)
    expect(outlineFits(700, 'split', 240, 220)).toBe(true)
  })
})
