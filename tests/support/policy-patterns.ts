// Patterns behind the policy tests (tests/policy), kept here so the tests can
// check the patterns themselves against sample text.

/**
 * Any CJK character: the Han, Hiragana, Katakana, Hangul and Bopomofo scripts
 * (so also the supplementary planes, U+20000 and up), plus the blocks that
 * hold their punctuation, marks and compatibility forms but belong to no
 * script of their own. Script, not Script_Extensions: that one also takes
 * ordinary characters such as the middle dot (U+00B7).
 */
export const CJK = new RegExp(
  '[' +
    [
      '\\p{Script=Han}',
      '\\p{Script=Hiragana}',
      '\\p{Script=Katakana}',
      '\\p{Script=Hangul}',
      '\\p{Script=Bopomofo}',
      '\\u3000-\\u303f',
      '\\u3040-\\u30ff',
      '\\u3100-\\u312f',
      '\\u3130-\\u318f', // Hangul compatibility jamo
      '\\u3190-\\u319f',
      '\\u31a0-\\u31bf',
      '\\u31c0-\\u31ef',
      '\\u31f0-\\u31ff',
      '\\u3200-\\u33ff',
      '\\uff00-\\uffef',
      '\\u{1f200}-\\u{1f2ff}',
    ].join('') +
    ']',
  'u',
)

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

/**
 * Whether a line writes out a colour: hex, rgb(), hsl() and the like, or a
 * named colour as a style value (`color: red`, `color: 'red'`). A quoted name
 * must be lower case, as in styles; a capitalised label such as 'Red' is text.
 * Unquoted values are CSS, where case does not matter.
 */
const COLOR_FUNCTION_OR_HEX = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i
const COLOR_WORDS = 'white|black|red|green|blue|gray|grey'
// Unquoted (a CSS value): CSS ignores case, so any case counts.
const COLOR_NAME_BARE = new RegExp(`:\\s*(?:${COLOR_WORDS})\\b`, 'i')
const COLOR_NAME_QUOTED = new RegExp(`:\\s*['"](?:${COLOR_WORDS})\\b`)
export function hasColorLiteral(line: string): boolean {
  return (
    COLOR_FUNCTION_OR_HEX.test(line) || COLOR_NAME_BARE.test(line) || COLOR_NAME_QUOTED.test(line)
  )
}

export const TEMP_FOLDER_REFERENCE = /\btmpdir\b|\bTMPDIR\b/

const GENERATED_TOKENS = /theme\/tokens\.(css|ts)$/

export function isColorChecked(path: string): boolean {
  return (
    /\.(css|ts|tsx)$/.test(path) &&
    !/\.(test|spec)\.tsx?$/.test(path) &&
    !GENERATED_TOKENS.test(path)
  )
}
