import { describe, expect, it } from 'vitest'
import {
  MAX_SPEECH_CHARS,
  leadingSpace,
  lookUpLabel,
  lookUpOrigin,
  lookUpSelection,
} from './textServices'

describe('the selection Look Up and Speech take', () => {
  it('is the selection trimmed, or nothing', () => {
    expect(lookUpSelection('  word\n')).toBe('word')
    expect(lookUpSelection('   ')).toBeNull()
    expect(lookUpSelection('')).toBeNull()
    expect(lookUpSelection(null)).toBeNull()
  })

  it('is cut to the longest speech takes, by characters', () => {
    const long = '\u{1F600}'.repeat(MAX_SPEECH_CHARS + 5)
    expect(Array.from(lookUpSelection(long) ?? '')).toHaveLength(MAX_SPEECH_CHARS)
  })
})

describe('the Look Up item text', () => {
  it('quotes a short selection and cuts a long one with an ellipsis', () => {
    expect(lookUpLabel('word')).toBe('Look Up “word”')
    expect(lookUpLabel('a  b\nc')).toBe('Look Up “a b c”')
    expect(lookUpLabel('x'.repeat(30))).toBe(`Look Up “${'x'.repeat(24)}…”`)
  })
})

describe('lookUpOrigin', () => {
  it('is the first character at its baseline, not a point inside or after the word', () => {
    expect(lookUpOrigin({ left: 120, bottom: 300 }, 4)).toEqual({ x: 120, y: 296 })
    expect(lookUpOrigin({ left: 0, bottom: 18 }, -1)).toEqual({ x: 0, y: 18 })
  })

  it('starts after the white space Look Up trims off', () => {
    expect(leadingSpace('word')).toBe(0)
    expect(leadingSpace('  \n\tword ')).toBe(4)
    expect(leadingSpace('   ')).toBe(3)
  })
})
