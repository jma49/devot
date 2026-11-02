import { describe, expect, it } from 'vitest'
import { countWords } from './words'

describe('countWords', () => {
  it('leaves out bare Markdown marks', () => {
    expect(countWords('## Pairing\n\n- [ ] Ask the relay')).toBe(4)
  })

  it('counts each CJK character as a word', () => {
    expect(countWords('\u540c\u6b65 sync \u3042\ud55c')).toBe(5)
  })

  it('counts nothing in empty text', () => {
    expect(countWords('')).toBe(0)
    expect(countWords(' \n ')).toBe(0)
  })
})
