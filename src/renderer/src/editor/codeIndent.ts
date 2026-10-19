// How Return and Tab indent in a fenced code block, by the block's language
// (its info string, ```py). Each language family has its own rule for
// what opens a level (a bracket, a colon, a keyword such as `do` or
// `then`, an opening tag) and, for Python, what ends one (`return`, `pass`
// ...). The indent unit follows the block itself when its lines are
// indented already, else the language's convention (a tab for Go, four
// spaces for Python, Rust, Java, C ...), else the editor's indent unit.
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

type Family = 'brace' | 'python' | 'yaml' | 'ruby' | 'lua' | 'shell' | 'markup' | 'plain'

const STYLES: Readonly<Record<string, { family: Family; unit?: string }>> = {
  javascript: { family: 'brace' },
  typescript: { family: 'brace' },
  jsx: { family: 'brace' },
  tsx: { family: 'brace' },
  json: { family: 'brace' },
  css: { family: 'brace' },
  scss: { family: 'brace' },
  less: { family: 'brace' },
  dart: { family: 'brace' },
  go: { family: 'brace', unit: '\t' },
  rust: { family: 'brace', unit: '    ' },
  java: { family: 'brace', unit: '    ' },
  kotlin: { family: 'brace', unit: '    ' },
  scala: { family: 'brace', unit: '    ' },
  groovy: { family: 'brace', unit: '    ' },
  c: { family: 'brace', unit: '    ' },
  'c++': { family: 'brace', unit: '    ' },
  'c#': { family: 'brace', unit: '    ' },
  'objective-c': { family: 'brace', unit: '    ' },
  swift: { family: 'brace', unit: '    ' },
  php: { family: 'brace', unit: '    ' },
  zig: { family: 'brace', unit: '    ' },
  python: { family: 'python', unit: '    ' },
  cython: { family: 'python', unit: '    ' },
  yaml: { family: 'yaml' },
  ruby: { family: 'ruby' },
  crystal: { family: 'ruby' },
  elixir: { family: 'ruby' },
  lua: { family: 'lua' },
  shell: { family: 'shell' },
  html: { family: 'markup' },
  xml: { family: 'markup' },
  vue: { family: 'markup' },
  makefile: { family: 'plain', unit: '\t' },
}

export interface CodeStyle {
  family: Family
  unit?: string
}

/** The style of a block's info string (`js`, `Python`, `c++ title="x"`); unknown ones are `brace`. */
export function codeStyle(info: string): CodeStyle {
  const word = info.trim().split(/\s/)[0]?.toLowerCase() ?? ''
  if (!word) return { family: 'brace' }
  if (word === 'make' || word === 'makefile' || word === 'mk') return STYLES.makefile!
  // A name or alias (`python`, `golang`), else a file extension (`py`, `rs`).
  const found =
    LanguageDescription.matchLanguageName(languages, word, true) ??
    LanguageDescription.matchFilename(languages, `file.${word}`)
  const name = found?.name.toLowerCase()
  return (name && STYLES[name]) || STYLES[word] || { family: 'brace' }
}

/**
 * The block's own indent unit, read from its lines' leading whitespace: a
 * tab, or the smallest run of 2, 3, 4 or 8 spaces. Undefined when no line
 * is indented.
 */
export function blockUnit(lines: readonly string[]): string | undefined {
  let spaces = Infinity
  for (const line of lines) {
    if (!/\S/.test(line)) continue
    const lead = /^[ \t]*/.exec(line)![0]
    if (lead.startsWith('\t')) return '\t'
    if (lead.length > 0) spaces = Math.min(spaces, lead.length)
  }
  return [2, 3, 4, 8].includes(spaces) ? ' '.repeat(spaces) : undefined
}

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' }
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
])

/** The line without a trailing `#` comment (one outside quotes, after a space). */
function withoutHashComment(text: string): string {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) return text.slice(0, i).trimEnd()
  }
  return text
}

function openTag(text: string): string | undefined {
  const m = /<([A-Za-z][\w:-]*)(?:\s[^<>]*)?>$/.exec(text)
  if (!m || m[0].endsWith('/>')) return undefined
  const name = m[1]!
  if (VOID_TAGS.has(name.toLowerCase())) return undefined
  return name
}

function opens(family: Family, text: string): boolean {
  const last = text.at(-1) ?? ''
  if (family !== 'markup' && CLOSERS[last]) return true
  switch (family) {
    case 'python':
      return withoutHashComment(text).endsWith(':')
    case 'yaml': {
      const line = withoutHashComment(text)
      return line.endsWith(':') || /^-\s*$/.test(line)
    }
    case 'ruby':
      return (
        /(?:^|\s)(?:do(?:\s*\|[^|]*\|)?|then)$/.test(text) ||
        (/^(?:def|class|module|if|unless|while|until|for|case|begin|else|elsif|when|rescue|ensure)\b/.test(
          text,
        ) &&
          !/\bend$/.test(text))
      )
    case 'lua':
      return (
        /(?:^|\s)(?:do|then|else|repeat)$/.test(text) ||
        (/\bfunction\b[^)]*\)$/.test(text) && !/\bend$/.test(text))
      )
    case 'shell':
      return /(?:^|[\s;])(?:then|do|else|in)$/.test(text)
    case 'markup':
      return openTag(text) !== undefined
    default:
      return false
  }
}

function ends(family: Family, text: string): boolean {
  return (
    family === 'python' && /^(?:return|pass|break|continue|raise)\b/.test(withoutHashComment(text))
  )
}

export interface NextLine {
  indent: string
  /** Text that goes on a line of its own after it, at the line's indent (a closing bracket or tag). */
  closing?: string
}

/**
 * The indent of the line Return starts, from the line before the cursor
 * (`before`, its container prefix removed) and the text after the cursor.
 */
export function nextLine(style: CodeStyle, unit: string, before: string, after: string): NextLine {
  const indent = /^[ \t]*/.exec(before)![0]
  const text = before.slice(indent.length).trimEnd()
  if (!text) return { indent }
  if (opens(style.family, text)) {
    const inner = indent + unit
    const closer = style.family === 'markup' ? `</${openTag(text)}>` : CLOSERS[text.at(-1)!]
    return closer && after.startsWith(closer)
      ? { indent: inner, closing: closer }
      : { indent: inner }
  }
  if (ends(style.family, text)) {
    const out = indent.endsWith(unit) ? indent.slice(0, -unit.length) : indent.replace(/[ \t]$/, '')
    return { indent: out }
  }
  return { indent }
}
