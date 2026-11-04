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
 * Whether a line writes out a colour: hex, rgb(), hsl(), or a named colour as a style value, an SVG or HTML
 * colour attribute, `setAttribute`, `style.x =` or `setProperty`. A quoted name must be lower case; a capitalised
 * one such as 'Red' is a label.
 */
const COLOR_FUNCTION_OR_HEX = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i
const COLOR_WORDS =
  '(?:dark|light|medium|pale|deep|hot|dim|slate|sky|steel|royal|midnight|forest|sea|olive)?' +
  '(?:white|black|red|green|blue|gr[ae]y|orange|purple|yellow|pink|brown|cyan|magenta|violet|indigo|teal|navy|' +
  'maroon|lime|silver|gold|aqua|fuchsia|beige|crimson|coral|salmon|turquoise|lavender|tomato|khaki|plum|orchid)'
const COLOR_ATTRIBUTE = '(?:fill|stroke|color|stop-color|flood-color|lighting-color|bgcolor)'
// Unquoted (CSS): any case counts.
const COLOR_NAME_BARE = new RegExp(`:\\s*${COLOR_WORDS}\\b`, 'i')
// Quoted (TypeScript): lower case only, a capitalised string is a label.
const COLOR_NAME_QUOTED = new RegExp(
  [
    `:\\s*['"\`]${COLOR_WORDS}\\b`,
    `\\b${COLOR_ATTRIBUTE}\\s*=\\s*\\{?\\s*['"\`]${COLOR_WORDS}\\b`,
    `setAttribute\\(\\s*['"\`]${COLOR_ATTRIBUTE}['"\`]\\s*,\\s*['"\`]${COLOR_WORDS}\\b`,
    `\\.style\\.[\\w$]+\\s*=\\s*['"\`]${COLOR_WORDS}\\b`,
    `setProperty\\(\\s*['"\`][\\w-]+['"\`]\\s*,\\s*['"\`]${COLOR_WORDS}\\b`,
  ].join('|'),
)
export function hasColorLiteral(line: string): boolean {
  return (
    COLOR_FUNCTION_OR_HEX.test(line) || COLOR_NAME_BARE.test(line) || COLOR_NAME_QUOTED.test(line)
  )
}

/** An SVG mask reads luminance, not colour: white keeps what it covers and black cuts it out. */
const COLOR_EXEMPTIONS: Record<string, RegExp> = {
  'src/renderer/src/preview/mermaid-theme.ts': /^\s*const MASK_(?:KEEP|CUT) = '(?:white|black)'$/,
}
export function isColorExempt(path: string, line: string): boolean {
  return COLOR_EXEMPTIONS[path]?.test(line) ?? false
}

/** The system temp folder named in code; tests reach it only through tempDir. */
export const TEMP_FOLDER_REFERENCE =
  /\btmpdir\b|\bTMPDIR\b|['"`]\/tmp\b|\bprocess\.env(?:\.|\[['"])(?:TMP|TEMP)\b/

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
const DURATION_NAME = String.raw`\b(?:ms|elapsed|took|duration|time|spent|latency|\w+(?:Ms|Millis|Elapsed|Duration|Spent))\b`
const CLOCK_DIFFERENCE = String.raw`-\s*(?:start|started|begin|before|t0)\b`
export const RAW_TIME_ASSERTION = new RegExp(
  [
    String.raw`expect\(${DURATION_NAME}[^)]*\)\.toBeLessThan`,
    String.raw`expect\([^)]*(?:performance|Date)\.now\(\)[^)]*\)\.toBeLessThan`,
    String.raw`expect\([^)]*${CLOCK_DIFFERENCE}[^)]*\)\.toBeLessThan`,
    String.raw`expect\([^)]*${DURATION_NAME}\s*<=?[^)]*\)\.toBe\(true\)`,
  ].join('|'),
)

/** A test that mocks the database (better-sqlite3, the core's storage, the test adapter) instead of using a real file. */
export const DATABASE_MOCK =
  /\bvi\.(?:do)?[mM]ock\(\s*['"`](?:better-sqlite3|[^'"`]*\/(?:storage|sqlite-adapter)(?:\.tsx?)?)['"`]/

/**
 * Line numbers of `unsafe` blocks and impls with no `SAFETY:` comment where clippy's undocumented_unsafe_blocks
 * looks: the comment lines (attributes and blank lines in between allowed) right above the line, or above the
 * statement that holds it.
 */
export function undocumentedUnsafe(source: string): number[] {
  const lines = source.split('\n')
  const code = (line: string) => line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '')
  const documentedAbove = (index: number) => {
    for (let j = index - 1; j >= 0; j--) {
      const text = lines[j]!.trim()
      if (text.startsWith('//')) {
        if (text.includes('SAFETY:')) return true
      } else if (text !== '' && !text.startsWith('#[')) {
        return false
      }
    }
    return false
  }
  const statementStart = (index: number) => {
    let j = index
    while (j > 0 && !/^let\b/.test(lines[j]!.trim())) {
      const previous = lines[j - 1]!.trim()
      if (previous === '' || previous.startsWith('//') || /[;{}]$/.test(code(previous).trim()))
        break
      j--
    }
    return j
  }
  return lines.flatMap((line, index) =>
    /\bunsafe\b(?!\s*(?:fn|extern|trait|\())/.test(code(line)) &&
    !documentedAbove(index) &&
    !documentedAbove(statementStart(index))
      ? [index + 1]
      : [],
  )
}
