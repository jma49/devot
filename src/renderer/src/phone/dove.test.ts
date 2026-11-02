import { describe, expect, it } from 'vitest'
import { cssUrl } from './dove'

describe('cssUrl', () => {
  it('quotes a data URL whose single quotes an unquoted url() cannot hold', () => {
    const data = "data:image/svg+xml,%3csvg%20xmlns='http://www.w3.org/2000/svg'%3e%3c/svg%3e"
    expect(cssUrl(data)).toBe(`url("${data}")`)
  })

  it('escapes a double quote, a backslash and a line break', () => {
    expect(cssUrl('a"b\\c\nd')).toBe('url("a\\"b\\\\c\\a d")')
  })
})
