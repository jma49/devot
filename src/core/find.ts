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

/** Never throws. */
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

function allMatches(text: string, options: FindOptions): Iterable<FindMatch> {
  const re = compile(options)
  return re === null || re === 'invalid' ? [] : matchesOf(text, re)
}

export interface FindChange {
  from: number
  to: number
  insert: string
}

/** In order and never overlapping; none for an invalid pattern. */
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

/** Read in pieces, so an update never copies the whole text. */
export interface FindText {
  readonly length: number
  slice(from: number, to: number): string
}

/** Where the text changed: `from` to `toA` in the old text became `from` to `toB` in the new. */
export interface FindTextChange {
  from: number
  toA: number
  toB: number
}

/** The new matches are the old ones before `before`, then `fresh` found again, then the old ones after them, moved. */
export interface FindUpdate {
  result: FindResult
  before: number
  fresh: number
}

function firstIndex(matches: readonly FindMatch[], test: (m: FindMatch) => boolean): number {
  let lo = 0
  let hi = matches.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (test(matches[mid]!)) hi = mid
    else lo = mid + 1
  }
  return lo
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** The first match that starts in `from`..`to`; `span` bounds a match's length. */
function matchIn(text: FindText, re: RegExp, from: number, to: number, span: number) {
  let start = from
  // A search never starts inside a character: the engine steps back to its start too.
  if (start > 0 && start < text.length) {
    const pair = text.slice(start - 1, start + 1)
    if (isHigh(pair.charCodeAt(0)) && isLow(pair.charCodeAt(1))) start -= 1
  }
  // One more than a match can read, so a character cut at the end is never part of one.
  const window = text.slice(start, Math.min(text.length, to + span + 1))
  re.lastIndex = 0
  const m = re.exec(window)
  if (!m || start + m.index >= to) return undefined
  const at = start + m.index
  return { from: at, to: at + m[0].length, captures: [...m], groups: undefined }
}

/**
 * What `findMatches` gives for the new text, from the old result and the
 * change, reading only around it; null when only a full search can tell (a
 * regular expression can depend on text anywhere, and a capped result lacks
 * the matches after the cap).
 */
export function updateMatches(
  old: FindResult,
  options: FindOptions,
  change: FindTextChange,
  text: FindText,
  limit = MAX_FIND_MATCHES,
): FindUpdate | null {
  if (options.regexp || old.capped || old.invalid) return null
  const re = compile(options)
  if (re === null) return { result: old, before: 0, fresh: 0 }
  if (re === 'invalid') return null
  // Each character of the query matches one character of the text, at most two code units.
  const span = 2 * options.query.length
  const delta = change.toB - change.toA
  // Whether a place starts a character depends on the code unit before it.
  const toB = Math.min(change.toB + 1, text.length)
  const { matches: olds } = old
  // A match that starts this far before the change read none of it.
  const before = firstIndex(olds, (m) => m.from > change.from - span)
  const matches = olds.slice(0, before)
  let full = false
  const add = (m: FindMatch) => {
    if (matches.length === limit) full = true
    else matches.push(m)
    return !full
  }
  // The scan stands at `at`: the next match is the first one that starts there or later.
  let at = Math.max(before > 0 ? olds[before - 1]!.to : 0, change.from - span + 1, 0)
  let fresh = 0
  for (;;) {
    let end = toB
    if (at >= toB) {
      // Back in step with the old scan once it, too, would look on from here.
      const next = firstIndex(olds, (m) => m.from >= at - delta)
      const stood = next > 0 ? olds[next - 1]!.to : 0
      if (stood <= at - delta) {
        for (let i = next; i < olds.length; i++) {
          const m = olds[i]!
          if (!add(delta === 0 ? m : { ...m, from: m.from + delta, to: m.to + delta })) break
        }
        break
      }
      end = stood + delta
    }
    const found = matchIn(text, re, at, end, span)
    if (!found) {
      at = end
      continue
    }
    if (!add(found)) break
    fresh += 1
    at = found.to
  }
  return { result: { matches, invalid: false, capped: full }, before, fresh }
}

const CHUNK = 4096

/** The span where two texts differ, found by comparing whole chunks; null when they are the same. */
export function changedSpan(a: string, b: string): FindTextChange | null {
  if (a === b) return null
  const most = Math.min(a.length, b.length)
  let from = 0
  for (let step = CHUNK; from < most && step > 0;) {
    const n = Math.min(step, most - from)
    if (a.slice(from, from + n) === b.slice(from, from + n)) from += n
    else step = n >> 1
  }
  let tail = 0
  for (let step = CHUNK; tail < most - from && step > 0;) {
    const n = Math.min(step, most - from - tail)
    if (
      a.slice(a.length - tail - n, a.length - tail) ===
      b.slice(b.length - tail - n, b.length - tail)
    )
      tail += n
    else step = n >> 1
  }
  return { from, toA: a.length - tail, toB: b.length - tail }
}
