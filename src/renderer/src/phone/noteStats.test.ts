import { describe, expect, it } from 'vitest'
import { noteStats } from './noteStats'

describe("a note's counts", () => {
  it('counts words, leaving out bare Markdown marks', () => {
    expect(noteStats('## Pairing\n\n- [ ] Ask the relay').words).toBe(4)
  })

  it('counts each CJK character as a word', () => {
    expect(noteStats('\u540c\u6b65 sync').words).toBe(3)
  })

  it('counts characters without whitespace, and reads at least a minute', () => {
    expect(noteStats('a b\nc')).toEqual({
      words: 3,
      characters: 3,
      readingMinutes: 1,
    })
    expect(noteStats('word '.repeat(401)).readingMinutes).toBe(3)
  })
})
