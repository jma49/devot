// A CJK character reads as a word of its own; other text splits on whitespace, and a piece is a word
// when it holds a letter or a digit. Characters are told apart by their code, which is far faster per
// character than a regular expression; only a letter or digit past ASCII is asked of Unicode.
const ALNUM = /^[\p{L}\p{N}]$/u

const isCjk = (code: number) =>
  (code >= 0x3040 && code <= 0x30ff) ||
  (code >= 0x3400 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af)

/** Whether the UTF-16 unit `code` is whitespace to JavaScript's `\s`: none is a surrogate. */
export function isSpaceCode(code: number): boolean {
  if (code < 0x80) return code === 0x20 || (code >= 0x09 && code <= 0x0d)
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

const isAsciiAlnum = (code: number) =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)

/** UTF-16 units in the code point at `at`: 2 for a surrogate pair, else 1. */
export function unitsAt(text: string, at: number): number {
  const code = text.charCodeAt(at)
  if (code < 0xd800 || code > 0xdbff) return 1
  const next = text.charCodeAt(at + 1)
  return next >= 0xdc00 && next <= 0xdfff ? 2 : 1
}

export function countWords(markdown: string): number {
  let words = 0
  let holds = false
  for (let at = 0; at < markdown.length;) {
    const code = markdown.charCodeAt(at)
    const units = code < 0x80 ? 1 : unitsAt(markdown, at)
    if (isSpaceCode(code) || isCjk(code)) {
      if (holds) words++
      holds = false
      if (isCjk(code)) words++
    } else if (!holds) {
      holds = code < 0x80 ? isAsciiAlnum(code) : ALNUM.test(markdown.slice(at, at + units))
    }
    at += units
  }
  return holds ? words + 1 : words
}
