import { describe, expect, it } from 'vitest'
import { utf8Length } from './text'

describe('utf8Length', () => {
  it('counts the bytes of the text as UTF-8', () => {
    expect(utf8Length('')).toBe(0)
    expect(utf8Length('aé€\u{1f600}')).toBe(1 + 2 + 3 + 4)
  })

  it('counts a lone surrogate as the replacement character it is stored as', () => {
    expect(utf8Length('\ud800')).toBe(3)
    expect(utf8Length('\udc00a')).toBe(4)
  })
})
