import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../tests/support/budget'
import { noteCounts } from './noteCounts'
import { readableText } from './readable'

// The counts as first defined, one code point and one word at a time: faster counting must agree.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/gu
const definedCounts = (markdown: string) => {
  const text = readableText(markdown)
  let characters = 0
  for (const c of text) if (!/\s/u.test(c)) characters++
  const words =
    (text.match(CJK)?.length ?? 0) +
    text
      .replace(CJK, ' ')
      .split(/\s+/u)
      .filter((word) => /[\p{L}\p{N}]/u.test(word)).length
  return { words, characters }
}

// ASCII and its whitespace, other spaces, CJK, combining marks, astral letters, emoji (joined, flags,
// variation selectors) and lone surrogates.
const PIECES = [
  'a',
  'Z',
  '7',
  ' ',
  '\t',
  '\n',
  '\v',
  '\f',
  '\r',
  '\u001c',
  '\u0085',
  '\u00a0',
  '\u2003',
  '\u2028',
  '\u3000',
  '\ufeff',
  '\u200b',
  '-',
  '*',
  '[x](y)',
  '\u00e9',
  'e\u0301',
  '\u0301',
  '\u0915\u094d\u0937',
  '\u540c',
  '\u3042',
  '\ud55c',
  '\u{20000}',
  '\u{1d400}',
  '\u{1f600}',
  '\u{1f468}\u200d\u{1f469}',
  '\u{1f1eb}\u{1f1f7}',
  '\u2764\ufe0f',
  '\u0660',
  '\ud800',
  '\udc00',
]
const unicodeText = fc
  .array(fc.constantFrom(...PIECES), { maxLength: 40 })
  .map((pieces) => pieces.join(''))

describe('noteCounts', () => {
  it('counts words and characters without whitespace', () => {
    expect(noteCounts('a b\nc')).toEqual({ words: 3, characters: 3 })
    expect(noteCounts('')).toEqual({ words: 0, characters: 0 })
  })

  it('leaves out front matter', () => {
    expect(noteCounts('---\ntitle: one two three\ntags: [a]\n---\nbody text')).toEqual({
      words: 2,
      characters: 8,
    })
  })

  it('counts the label of a link and the alt text of an image, not their Markdown', () => {
    expect(noteCounts('See [the docs](https://example.com/some/long/path) now')).toEqual({
      words: 4,
      characters: 13,
    })
    expect(noteCounts('![a cat](cat.png)')).toEqual({ words: 2, characters: 4 })
    expect(noteCounts('[ref][1] x\n\n[1]: http://example.com "title"').words).toBe(2)
  })

  it('counts each CJK character as a word', () => {
    expect(noteCounts('\u540c\u6b65 sync \u3042\ud55c')).toEqual({ words: 5, characters: 8 })
  })

  it('counts a code point as one character, and a word only when it holds a letter or digit', () => {
    expect(
      noteCounts(
        '# Caf\u00e9 \u540c\u6b65\n\nA *na\u0308ive* [link \u{1f600}](https://x.y) and **\u{1f468}\u200d\u{1f469}\u200d\u{1f467} family** _e\u0301t\u00e9_ ~~\u3042\u3044~~ `\u4f1a\u{1f600}`',
      ),
    ).toEqual({ words: 12, characters: 40 })
    expect(noteCounts('> lone \ud800 surrogate \udc00 *x*\u{1f600}*y* \u2003em\u2028line')).toEqual(
      { words: 5, characters: 24 },
    )
    expect(noteCounts('\u{1f600} \u0301 \u2764\ufe0f \u00a0\u3000 \u{1d400}')).toEqual({
      words: 1,
      characters: 5,
    })
  })

  it('counts any text as the definition does', () => {
    fc.assert(
      fc.property(unicodeText, (markdown) => {
        expect(noteCounts(markdown)).toEqual(definedCounts(markdown))
      }),
      { numRuns: 3000 },
    )
  })

  it('leaves out bare Markdown marks', () => {
    expect(noteCounts('## Pairing\n\n- [ ] Ask the relay')).toMatchObject({ words: 4 })
    expect(noteCounts('**bold** and `code`')).toEqual({ words: 3, characters: 11 })
  })

  it('counts a long note within a budget', (context) => {
    const note = `# Title\n\n${'Some *words* in a [link](https://example.com/page) here.\n\n'.repeat(5000)}`
    const start = performance.now()
    const counts = noteCounts(note)
    expectWithinBudget(context, performance.now() - start, 500)
    expect(counts.words).toBe(5000 * 6 + 1)
  })
})
