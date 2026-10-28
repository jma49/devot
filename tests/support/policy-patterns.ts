// Patterns behind tests/policy, kept here so tests can check them against sample text.

/**
 * Any CJK character: Han, Hiragana, Katakana, Hangul and Bopomofo (incl. supplementary planes), plus the blocks for
 * their punctuation and compatibility forms. Script, not Script_Extensions, which also takes the middle dot (U+00B7).
 */
export const CJK = new RegExp(
  '[' +
    [
      '\\p{Script=Han}',
      '\\p{Script=Hiragana}',
      '\\p{Script=Katakana}',
      '\\p{Script=Hangul}',
      '\\p{Script=Bopomofo}',
      '\\u3000-\\u303f', // CJK symbols and punctuation
      '\\u3040-\\u30ff', // Hiragana and Katakana, with their marks
      '\\u3100-\\u312f', // Bopomofo
      '\\u3130-\\u318f', // Hangul compatibility jamo
      '\\u3190-\\u319f', // Kanbun
      '\\u31a0-\\u31bf', // Bopomofo extended
      '\\u31c0-\\u31ef', // CJK strokes
      '\\u31f0-\\u31ff', // Katakana phonetic extensions
      '\\u3200-\\u33ff', // enclosed and compatibility CJK
      '\\uff00-\\uffef', // fullwidth and halfwidth forms
      '\\u{1f200}-\\u{1f2ff}', // enclosed ideographic supplement
    ].join('') +
    ']',
  'u',
)

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

/**
 * Whether a line writes out a colour: hex, rgb(), hsl(), or a named colour as a style value. A quoted name must be
 * lower case; a capitalised one such as 'Red' is a label.
 */
const COLOR_FUNCTION_OR_HEX = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i
const COLOR_WORDS = 'white|black|red|green|blue|gray|grey'
// Unquoted (CSS): any case counts.
const COLOR_NAME_BARE = new RegExp(`:\\s*(?:${COLOR_WORDS})\\b`, 'i')
// Quoted (TypeScript): lower case only, a capitalised string is a label.
const COLOR_NAME_QUOTED = new RegExp(`:\\s*['"](?:${COLOR_WORDS})\\b`)
export function hasColorLiteral(line: string): boolean {
  return (
    COLOR_FUNCTION_OR_HEX.test(line) || COLOR_NAME_BARE.test(line) || COLOR_NAME_QUOTED.test(line)
  )
}

/** The system temp folder named in code; tests reach it only through tempDir. */
export const TEMP_FOLDER_REFERENCE = /\btmpdir\b|\bTMPDIR\b/

/** The generated design tokens are the one place colours are written out. */
const GENERATED_TOKENS = /theme\/tokens\.(css|ts)$/

export function isColorChecked(path: string): boolean {
  return (
    /\.(css|ts|tsx)$/.test(path) &&
    !/\.(test|spec)\.tsx?$/.test(path) &&
    !GENERATED_TOKENS.test(path)
  )
}

/** A duration compared straight against a limit, which fails on an overloaded machine instead of skipping. */
export const RAW_TIME_ASSERTION =
  /expect\((?:ms|elapsed|took|duration|time)\b[^)]*\)\.toBeLessThan|expect\([^)]*(?:performance|Date)\.now\(\)[^)]*\)\.toBeLessThan/
