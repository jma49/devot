import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { lowercaseOnly, TagDot } from './TagDot'

describe('a tag dot beside its name', () => {
  it('takes the x-height centre only for a name in lower case alone', () => {
    expect(
      ['test', 'to-do', 'caf\u00e9', 'read later'].filter((name) => !lowercaseOnly(name)),
    ).toEqual([])
    expect(
      ['Design', 'q3', 'NASA', '\u6d4b\u8bd5', 'test\u6d4b', '#', ''].filter(lowercaseOnly),
    ).toEqual([])
  })

  it('marks the dot of a lower-case name', () => {
    expect(renderToStaticMarkup(<TagDot color="red" name="test" />)).toContain('data-lowercase=""')
    expect(renderToStaticMarkup(<TagDot color="red" name="Test" />)).not.toContain('data-lowercase')
    expect(renderToStaticMarkup(<TagDot color="red" />)).not.toContain('data-lowercase')
  })
})
