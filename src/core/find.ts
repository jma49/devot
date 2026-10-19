// Find and replace inside one note: the matching rules shared by the editor
// (the Markdown source) and the preview (the rendered text). Offsets are
// UTF-16 code units, like CodeMirror's and the DOM's.
import { escapeRegExp } from './search'

export interface FindOptions {
  query: string
  regexp: boolean
  caseSensitive: boolean
}

export interface FindMatch {
  from: number
  to: number
  captures: readonly (string | undefined)[]
  groups: Readonly<Record<string, string | undefined>> | undefined
}

export interface FindResult {
  matches: FindMatch[]
  invalid: boolean
  capped: boolean
}

export const MAX_FIND_MATCHES = 10_000

/** Unicode mode, so a match never splits a character outside the basic plane and `\p{...}` classes work; a pattern only the older syntax accepts (`\#`, `\-`, a lone `{` or `]`) runs without it. */
function compile(options: FindOptions): RegExp | null | 'invalid' {
  if (options.query === '') return null
  const source = options.regexp ? options.query : escapeRegExp(options.query)
  const flags = `g${options.regexp ? 'm' : ''}${options.caseSensitive ? '' : 'i'}`
  for (const unicode of ['u', '']) {
    try {
      return new RegExp(source, flags + unicode)
    } catch {
      // Try the older syntax, then give up.
    }
  }
  return 'invalid'
}

function advance(text: string, index: number): number {
  const code = text.codePointAt(index)
  return index + (code !== undefined && code > 0xffff ? 2 : 1)
}

function* matchesOf(text: string, re: RegExp): Generator<FindMatch> {
  re.lastIndex = 0
  while (re.lastIndex <= text.length) {
    const m = re.exec(text)
    if (!m) return
    const from = m.index
    const to = from + m[0].length
    yield { from, to, captures: [...m], groups: m.groups ? { ...m.groups } : undefined }
    // An empty match would be found again at the same place.
    if (to === from) re.lastIndex = advance(text, to)
  }
}

export function findMatches(
  text: string,
  options: FindOptions,
  limit = MAX_FIND_MATCHES,
): FindResult {
  const re = compile(options)
  if (re === 'invalid') return { matches: [], invalid: true, capped: false }
  if (re === null) return { matches: [], invalid: false, capped: false }
  const matches: FindMatch[] = []
  for (const match of matchesOf(text, re)) {
    if (matches.length === limit) return { matches, invalid: false, capped: true }
    matches.push(match)
  }
  return { matches, invalid: false, capped: false }
}

/** A regular expression expands `$&`, `$1`..`$99`, `$<name>`, `` $` ``, `$'` and `$$` as String.prototype.replace does. */
export function expandReplacement(
  template: string,
  match: FindMatch,
  source: string,
  regexp: boolean,
): string {
  if (!regexp || !template.includes('$')) return template
  const groupCount = match.captures.length - 1
  let out = ''
  let i = 0
  while (i < template.length) {
    const char = template[i]!
    const next = template[i + 1]
    if (char !== '$' || next === undefined) {
      out += char
      i += 1
      continue
    }
    if (next === '$') {
      out += '$'
      i += 2
    } else if (next === '&') {
      out += match.captures[0] ?? ''
      i += 2
    } else if (next === '`') {
      out += source.slice(0, match.from)
      i += 2
    } else if (next === "'") {
      out += source.slice(match.to)
      i += 2
    } else if (next >= '0' && next <= '9') {
      const two = template.slice(i + 1, i + 3)
      const twoIndex = /^\d\d$/.test(two) ? Number(two) : 0
      const oneIndex = Number(next)
      if (twoIndex >= 1 && twoIndex <= groupCount) {
        out += match.captures[twoIndex] ?? ''
        i += 3
      } else if (oneIndex >= 1 && oneIndex <= groupCount) {
        out += match.captures[oneIndex] ?? ''
        i += 2
      } else {
        out += '$'
        i += 1
      }
    } else if (next === '<' && match.groups) {
      const close = template.indexOf('>', i + 2)
      if (close < 0) {
        out += '$<'
        i += 2
      } else {
        out += match.groups[template.slice(i + 2, close)] ?? ''
        i = close + 1
      }
    } else {
      out += '$'
      i += 1
    }
  }
  return out
}

export function allMatches(text: string, options: FindOptions): Iterable<FindMatch> {
  const re = compile(options)
  return re === null || re === 'invalid' ? [] : matchesOf(text, re)
}

export interface FindChange {
  from: number
  to: number
  insert: string
}

export function replacementChanges(
  text: string,
  options: FindOptions,
  template: string,
): FindChange[] {
  return Array.from(allMatches(text, options), (m) => ({
    from: m.from,
    to: m.to,
    insert: expandReplacement(template, m, text, options.regexp),
  }))
}

export function replaceAll(
  text: string,
  options: FindOptions,
  template: string,
): { text: string; count: number } {
  const changes = replacementChanges(text, options, template)
  let out = ''
  let last = 0
  for (const change of changes) {
    out += text.slice(last, change.from) + change.insert
    last = change.to
  }
  return { text: changes.length === 0 ? text : out + text.slice(last), count: changes.length }
}
