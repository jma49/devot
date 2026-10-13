import { describe, expect, it } from 'vitest'
import { limitEdit } from './nameLimit'

describe('name fields stop at a limit in code points', () => {
  it('leaves an edit within the limit alone', () => {
    expect(limitEdit('abc', 'abcd', 4)).toEqual({ value: 'abcd', caret: null })
  })

  it('keeps only what fits of typed or pasted text, where it was inserted', () => {
    expect(limitEdit('abcd', 'abcde', 4)).toEqual({ value: 'abcd', caret: 4 })
    expect(limitEdit('ab', 'aXYZb', 4)).toEqual({ value: 'aXYb', caret: 3 })
    // A replaced selection makes room.
    expect(limitEdit('abcd', 'aWXYZd', 4)).toEqual({ value: 'aWXd', caret: 3 })
  })

  it('counts an emoji as one character and never splits it', () => {
    const smile = '\u{1f600}'
    expect(limitEdit(smile.repeat(3), smile.repeat(4), 4).value).toBe(smile.repeat(4))
    expect(limitEdit(smile.repeat(3), smile.repeat(5), 4)).toEqual({
      value: smile.repeat(4),
      caret: 8,
    })
  })

  it('cuts text that is already too long at the end', () => {
    expect(limitEdit('abcdef', 'abcdefg', 4)).toEqual({ value: 'abcd', caret: null })
  })
})
