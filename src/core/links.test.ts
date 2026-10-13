import { describe, expect, it } from 'vitest'
import { noteLink, noteLinks, noteUri } from './links'

const A = '0192a6f0-0000-7000-8000-00000000000a'
const B = '0192a6f0-0000-7000-8000-00000000000b'

describe('noteLinks', () => {
  it('finds every note a body links to, once each, sorted', () => {
    const body = `See [b](devot://note/${B}) and [a](devot://note/${A}).\n\n<devot://note/${B}>`
    expect(noteLinks(body)).toEqual([A, B])
  })

  it('ignores attachments, other schemes and malformed IDs', () => {
    expect(
      noteLinks(
        [
          `![](devot://file/${A})`,
          `https://example.com/devot://note/x`,
          `devot://note/${A.toUpperCase()}`,
          `devot://note/0192a6f0-0000-4000-8000-00000000000a`,
          `devot://note/${A.slice(0, 30)}`,
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('returns nothing for an empty body', () => {
    expect(noteLinks('')).toEqual([])
  })
})

describe('noteLink', () => {
  it('writes a standard Markdown link to the note', () => {
    expect(noteLink('Groceries', A)).toBe(`[Groceries](devot://note/${A})`)
  })

  it('escapes brackets and backslashes in the title', () => {
    expect(noteLink('a [b] c\\d', A)).toBe(`[a \\[b\\] c\\\\d](devot://note/${A})`)
  })

  it('keeps the link on one line', () => {
    expect(noteLink('two\nlines', A)).toBe(`[two lines](devot://note/${A})`)
  })
})

describe('noteUri', () => {
  it('is the devot://note/<id> URI that links resolve by', () => {
    expect(noteUri(A)).toBe(`devot://note/${A}`)
  })

  it('is the target of the note link and is found by the link index', () => {
    expect(noteLink('Groceries', A)).toBe(`[Groceries](${noteUri(A)})`)
    expect(noteLinks(noteUri(A))).toEqual([A])
    expect(noteLinks(noteLink('a [b]', B))).toEqual([B])
  })
})
