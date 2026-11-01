import { expect, it } from 'vitest'
import { isScrolled } from './scrollEdge'

it('fades only after moving below the top, including fractional scrolling', () => {
  for (const top of [0, -1, -20, NaN]) expect(isScrolled(top)).toBe(false)
  for (const top of [0.1, 1, 4, 28, 500]) expect(isScrolled(top)).toBe(true)
})
