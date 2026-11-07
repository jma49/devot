import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { countWords, isSpaceCode } from './words'

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/gu
const definedWords = (text: string) =>
  (text.match(CJK)?.length ?? 0) +
  text
    .replace(CJK, ' ')
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length

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

  it('counts a word for any letter or digit, past ASCII too, and none for marks or emoji alone', () => {
    expect(
      countWords('\u0301 \u{1f600} \u2764\ufe0f -- e\u0301 \u{1d400} \u0660 x\u00a0y\u3000z'),
    ).toBe(6)
    expect(countWords('a\u540cb \ud800 \udc00a')).toBe(4)
  })

  it('reads whitespace by its code exactly as \\s does', () => {
    const differ = Array.from({ length: 0x10000 }, (_, code) => code).filter(
      (code) => isSpaceCode(code) !== /^\s$/u.test(String.fromCharCode(code)),
    )
    expect(differ).toEqual([])
  })

  it('counts any text as the definition does', () => {
    const piece = fc.constantFrom(
      ...['a', '9', ' ', '\t', '\n', '\v', '\u001c', '\u0085', '\u00a0', '\u2028', '\u3000'],
      ...['\ufeff', '\u200b', '*', '\u00e9', '\u0301', '\u540c', '\u30a2', '\uac00', '\ud7af'],
      ...['\u{20000}', '\u{1d400}', '\u{1f600}', '\u2764\ufe0f', '\u0660', '\ud800', '\udc00'],
    )
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
        const text = pieces.join('')
        expect(countWords(text)).toBe(definedWords(text))
      }),
      { numRuns: 3000 },
    )
  })
})
