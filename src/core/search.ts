// Search queries. A query is a list of clauses, all of which must hold:
//
//   word  "a phrase"       the title or body contains it (case-insensitive substring)
//   title:word  body:word  only the title, or only the body, contains it
//   book:Name              the note is in that notebook or one of its sub-notebooks
//   tag:Name               the note has that tag
//   status:Name            the note has that status (an ID such as on_hold, or a name such as "On Hold")
//   -anything              excludes what the clause matches
//
// Names match in any case; values with spaces are quoted (book:"Weekly notes").
// Anything the parser cannot read (an unknown qualifier, an empty value, a
// status that does not exist) is searched for as plain text, so a query
// never fails. Storage uses its trigram index for text of three characters
// or more and scans for shorter text (common two-character Chinese words).

import { bookWithDescendants, MAX_BOOK_NAME_CHARS, TEMPLATES_BOOK_ID } from './books'
import { FRONT_MATTER_FENCE, readableText } from './readable'
import {
  NOTE_STATUSES,
  type BookRecord,
  type NoteQuery,
  type NoteStatus,
  type SetCondition,
  type TagRecord,
  type TextCondition,
} from './storage'
import { MAX_TAG_NAME_CHARS, sameName, type NoteFilter } from './tags'

/** Most clauses a query keeps; more are ignored. */
export const MAX_SEARCH_TERMS = 10
/**
 * Most characters a text value keeps (storage accepts no longer). Notebook
 * and tag names resolve to IDs before storage, so they keep up to the
 * longest name a notebook or a tag can have.
 */
export const MAX_TERM_CHARS = 100
export const SEARCH_LIMIT = 200

export type SearchField = 'any' | 'title' | 'body' | 'book' | 'tag' | 'status'

/** One clause of a query. A status clause holds the status ID. */
export interface SearchClause {
  field: SearchField
  value: string
  negate: boolean
}

/** The view a search narrows: a notebook (null: all notes) and a filter. */
export interface SearchScope {
  bookId: string | null
  filter: NoteFilter | null
}

const QUALIFIERS = new Set<SearchField>(['title', 'body', 'book', 'tag', 'status'])
const QUALIFIER = /^([A-Za-z]+):/
const SPACE = /\s/

/** A status from its ID or its name, in any case, with spaces, hyphens or underscores. */
export function statusFromName(name: string): NoteStatus | null {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
  if (key === 'no_status') return 'none'
  return (NOTE_STATUSES as readonly string[]).includes(key) ? (key as NoteStatus) : null
}

/** `text` with each lone surrogate (which cannot cross to storage as text) replaced by U+FFFD. */
export const wellFormed = (text: string) =>
  text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')

const MAX_CHARS: Partial<Record<SearchField, number>> = {
  book: MAX_BOOK_NAME_CHARS,
  tag: MAX_TAG_NAME_CHARS,
}

const clip = (value: string, field: SearchField = 'any') =>
  [...value]
    .slice(0, MAX_CHARS[field] ?? MAX_TERM_CHARS)
    .join('')
    .trim()

/** The clauses of a query; never throws. */
export function parseSearch(query: string): SearchClause[] {
  const text = wellFormed(query)
  const clauses: SearchClause[] = []
  let at = 0

  /** Reads a quoted value from `at` (on the opening quote) to its closing quote or the end. */
  const quoted = () => {
    const close = text.indexOf('"', at + 1)
    const end = close < 0 ? text.length : close
    const value = text.slice(at + 1, end)
    at = close < 0 ? text.length : close + 1
    return value
  }
  /** Reads up to the next whitespace. */
  const word = () => {
    const start = at
    while (at < text.length && !SPACE.test(text[at]!)) at += 1
    return text.slice(start, at)
  }

  while (at < text.length && clauses.length < MAX_SEARCH_TERMS) {
    if (SPACE.test(text[at]!)) {
      at += 1
      continue
    }
    // A leading minus excludes, unless nothing follows it.
    const negate = text[at] === '-' && at + 1 < text.length && !SPACE.test(text[at + 1]!)
    if (negate) at += 1
    const bodyStart = at

    let field: SearchField = 'any'
    let value: string
    let qualified = false
    if (text[at] === '"') {
      value = quoted()
    } else {
      const key = QUALIFIER.exec(text.slice(at, at + 12))
      const name = key?.[1]?.toLowerCase() as SearchField | undefined
      if (key && name && QUALIFIERS.has(name)) {
        qualified = true
        field = name
        at += key[0].length
        value = text[at] === '"' ? quoted() : word()
      } else {
        value = word()
      }
    }

    let clean = clip(value, field)
    if (field === 'status') {
      const status = statusFromName(clean)
      clean = status ?? ''
    }
    if (qualified && clean === '') {
      // Malformed: search for what was typed, as text.
      field = 'any'
      clean = clip(text.slice(bodyStart, at))
    }
    // An empty phrase ("") is no clause.
    if (clean === '') continue
    clauses.push({ field, value: clean, negate })
  }
  return clauses
}

/** The words to mark in titles and in body excerpts: what the query looks for. */
export function highlightTerms(clauses: readonly SearchClause[]): {
  title: string[]
  body: string[]
} {
  const positive = clauses.filter((c) => !c.negate)
  const of = (fields: SearchField[]) =>
    positive.filter((c) => fields.includes(c.field)).map((c) => c.value)
  return { title: of(['any', 'title']), body: of(['any', 'body']) }
}

/** `text` with the characters regular expressions treat as syntax escaped. */
export const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

/** A pattern matching any of `terms` in any case (longest first); null for none. */
export function searchPattern(terms: readonly string[]): RegExp | null {
  const pattern = [...new Set(terms.filter((t) => t !== ''))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  return pattern ? new RegExp(pattern, 'giu') : null
}

/**
 * `text` split into runs that match `pattern` (see `searchPattern`) and runs
 * that do not, in order. Joined, the runs give `text` back.
 */
export function matchSegments(
  text: string,
  pattern: RegExp | null,
): { text: string; match: boolean }[] {
  if (!text) return []
  if (!pattern) return [{ text, match: false }]
  const segments: { text: string; match: boolean }[] = []
  let last = 0
  // matchAll works on a copy of the pattern, so it can be shared.
  for (const m of wellFormed(text).matchAll(pattern)) {
    if (m[0] === '') continue
    if (m.index > last) segments.push({ text: text.slice(last, m.index), match: false })
    const previous = segments.at(-1)
    if (previous?.match && m.index === last) previous.text += m[0]
    else segments.push({ text: m[0], match: true })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false })
  return segments
}

/** Characters of body an excerpt shows, and how many come before the word found. */
export const EXCERPT_CHARS = 160
export const EXCERPT_BEFORE = 40

/**
 * Characters (code points) of a long body read on each side of the place a
 * word is found there (see bodyExcerpt); a body of at most twice as many is
 * read whole.
 */
export const EXCERPT_STRETCH = 300
/** How many places of a word a long body's excerpt tries. */
export const EXCERPT_PLACES = 8

/**
 * Lower case, one character for one (as the trigram index folds case, and
 * as the Rust store's `fold` does: tests/support/folds.json holds cases both
 * agree on).
 */
const fold = (chars: readonly string[]) =>
  chars.map((c) => {
    const lower = c.toLowerCase()
    return [...lower].length === 1 ? lower : c
  })

/**
 * `text` folded as `fold` does, in one string with the same UTF-16 layout
 * (no code point's lower case changes its length). Only U+0130 lowers to
 * two code points, and only U+03A3 lowers by context (at the end of a
 * word), so without them the whole string's lower case is the same.
 * Storage scans terms too short for its trigram index with this, as the SQL
 * function `devot_fold` (src/mcp/sqlite.ts, storage/mod.rs).
 */
export const foldText = (text: string) =>
  /[\u0130\u03a3]/.test(text) ? fold([...text]).join('') : text.toLowerCase()

/** UTF-16 index of the code point `count` code points before `at` (or 0). */
function codePointsBack(text: string, at: number, count: number): number {
  let i = at
  for (let n = 0; n < count && i > 0; n += 1) {
    i -= 1
    if (i > 0 && isLowSurrogate(text.charCodeAt(i)) && isHighSurrogate(text.charCodeAt(i - 1))) {
      i -= 1
    }
  }
  return i
}

/** UTF-16 index of the code point `count` code points after `at` (or the end). */
function codePointsAhead(text: string, at: number, count: number): number {
  let i = at
  for (let n = 0; n < count && i < text.length; n += 1) {
    i += isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1
  }
  return i
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/** Whether `text` has more than `count` code points. */
const longerThan = (text: string, count: number) =>
  text.length > 2 * count || (text.length > count && codePointsAhead(text, 0, count) < text.length)

/**
 * Where a body's text starts after a leading front matter block, as
 * readableText reads one (a fence line, then another later); 0 without one.
 */
function afterFrontMatter(body: string): number {
  const line = (from: number) => {
    const end = body.indexOf('\n', from)
    const to = end < 0 ? body.length : end
    return {
      text: body.slice(from, body[to - 1] === '\r' ? to - 1 : to),
      next: end < 0 ? -1 : end + 1,
    }
  }
  let { text, next } = line(0)
  if (!FRONT_MATTER_FENCE.test(text)) return 0
  while (next >= 0) {
    ;({ text, next } = line(next))
    if (FRONT_MATTER_FENCE.test(text)) return next < 0 ? body.length : next
  }
  return 0
}

/** How many code points `text` has from `from` up to `to`, counting at most `limit`. */
function codePointsBetween(text: string, from: number, to: number, limit: number): number {
  let count = 0
  for (let i = from; i < to && count < limit; count += 1) i = codePointsAhead(text, i, 1)
  return count
}

/**
 * Where the first of `terms` (in any case) shows in `text`, a stretch of
 * readable text: where the excerpt starts (UTF-16), EXCERPT_BEFORE
 * characters (code points) before the term or at the start, and how many
 * characters come before the term (EXCERPT_BEFORE at most).
 */
function placeIn(text: string, terms: readonly string[]) {
  const folded = foldText(text)
  for (const term of terms) {
    const wanted = foldText(term)
    if (!wanted) continue
    const at = folded.indexOf(wanted)
    if (at < 0) continue
    const from = codePointsBack(text, at, EXCERPT_BEFORE)
    return { text, from, at, before: codePointsBetween(text, from, at, EXCERPT_BEFORE) }
  }
  return undefined
}

/** The spaces and line breaks that set words apart. */
const isBreak = (char: string | undefined) =>
  char === ' ' || char === '\n' || char === '\t' || char === '\r'

/**
 * Where an excerpt starting at `from` (UTF-16) begins to read: at `from`
 * when it falls at a word's start, else at the next word's, so an excerpt
 * never opens with the tail of a word. A cut that finds no break before the
 * term at `at` (a term in a long word, or text without spaces) stays where
 * it falls. The Rust store's `word_start` follows the same rule.
 */
function wordStart(text: string, from: number, at: number): number {
  if (from === 0 || isBreak(text[from - 1]) || isBreak(text[from])) return from
  let i = from
  while (i < at && !isBreak(text[i])) i += 1
  if (i >= at) return from
  while (i < at && isBreak(text[i])) i += 1
  return i
}

/** The excerpt of a place; `cut` when its text starts after the body's start. */
const excerptAt = (
  { text, from, at }: { text: string; from: number; at: number },
  cut: boolean,
) => {
  const start = wordStart(text, from, at)
  return `${cut || start > 0 ? '\u2026' : ''}${text.slice(start, codePointsAhead(text, start, EXCERPT_CHARS))}`
}

/**
 * About 160 characters of the readable text of `body` (see `readableText`:
 * no front matter, no Markdown markers) from shortly before the first of
 * `terms` found in it (in any case), starting with an ellipsis when it
 * starts mid-text; undefined when no term is found there.
 *
 * A body longer than twice EXCERPT_STRETCH characters is not read whole, so
 * a page of results costs the same however long the notes are. There, a
 * term is looked for as written (in any case: a word that only markers cut
 * apart is not found), at most EXCERPT_PLACES times, after any front
 * matter. Each place found is read with EXCERPT_STRETCH characters on each
 * side as a body of its own (front matter only at the body's start); the
 * first term whose place shows it as readable text gives the excerpt (the
 * stretch grows a stretch at a time, at most EXCERPT_PLACES times, while
 * the word shows too near one of its ends for a whole excerpt). What
 * lies outside the stretch (a code fence or comment opened before it, a
 * link reference defined elsewhere, the other end of a long emphasis) is
 * not known there. The Rust store's `body_excerpt` follows the same rule
 * (tests/support/excerpts.json holds cases both sides agree on).
 */
export function bodyExcerpt(body: string, terms: readonly string[]): string | undefined {
  if (!longerThan(body, 2 * EXCERPT_STRETCH)) {
    const place = placeIn(readableText(body), terms)
    return place && excerptAt(place, false)
  }
  const lower = foldText(body)
  const text = afterFrontMatter(body)
  // The readable text of body[start, stop), read as a body of its own: a
  // blank first line, so front matter is read only at the body's start.
  const readable = (start: number, stop: number) =>
    readableText(start === 0 ? body.slice(0, stop) : `\n${body.slice(start, stop)}`)
  for (const term of terms) {
    const wanted = foldText(term)
    if (!wanted) continue
    let from = text
    for (let tries = 0; tries < EXCERPT_PLACES; tries += 1) {
      const at = lower.indexOf(wanted, from)
      if (at < 0) break
      // EXCERPT_STRETCH characters on each side, from the body's start when
      // that reaches the front matter.
      let start = codePointsBack(body, at, EXCERPT_STRETCH)
      if (start <= text) start = 0
      let stop = codePointsAhead(body, at + wanted.length, EXCERPT_STRETCH)
      let place = placeIn(readable(start, stop), [term])
      // Shown near an end of the stretch (another place than this one): read
      // further that way, a stretch at a time, until the excerpt fits.
      for (let more = 0; place && more < EXCERPT_PLACES; more += 1) {
        const short = start > 0 && place.before < EXCERPT_BEFORE
        const long =
          stop < body.length &&
          codePointsBetween(place.text, place.from, place.text.length, EXCERPT_CHARS) <
            EXCERPT_CHARS
        if (!short && !long) break
        if (short) start = codePointsBack(body, start, EXCERPT_STRETCH)
        if (start <= text) start = 0
        if (long) stop = codePointsAhead(body, stop, EXCERPT_STRETCH)
        place = placeIn(readable(start, stop), [term])
      }
      if (place) return excerptAt(place, start > 0)
      from = codePointsAhead(lower, at, 1)
    }
  }
  return undefined
}

/** The words storage cuts excerpts around: what the query looks for in bodies. */
export const excerptTerms = (query: NoteQuery) =>
  query.text.filter((t) => !t.negate && t.field !== 'title').map((t) => t.value)

export interface ResolveContext {
  /** Live notebooks, for sub-notebooks. */
  books: readonly BookRecord[]
  tags: readonly TagRecord[]
  /** The view the search narrows. */
  scope?: SearchScope | undefined
  /** The notebooks `book:` may name (default: all of `books`). */
  nameable?: readonly BookRecord[] | undefined
}

/**
 * The query storage runs for `clauses`: notebook and tag names become IDs,
 * and the view adds its own conditions. Null when nothing can match (a
 * `book:` or `tag:` naming nothing).
 */
export function resolveSearch(
  clauses: readonly SearchClause[],
  context: ResolveContext,
): NoteQuery | null {
  const { books, tags, scope } = context
  const nameable = context.nameable ?? books
  const text: TextCondition[] = []
  const sets: SetCondition[] = []

  if (scope?.bookId)
    sets.push({ kind: 'book', ids: [...bookWithDescendants(books, scope.bookId)], negate: false })
  const filter = scope?.filter
  if (filter?.kind === 'status') sets.push({ kind: 'status', ids: [filter.status], negate: false })
  if (filter?.kind === 'tag') sets.push({ kind: 'tag', ids: [filter.tagId], negate: false })

  for (const c of clauses) {
    if (c.field === 'any' || c.field === 'title' || c.field === 'body') {
      text.push({ field: c.field, value: c.value, negate: c.negate })
      continue
    }
    let ids: string[]
    if (c.field === 'status') ids = [c.value]
    else if (c.field === 'tag') ids = tags.filter((t) => sameName(t.name, c.value)).map((t) => t.id)
    else {
      const found = new Set<string>()
      for (const named of nameable.filter((b) => sameName(b.name, c.value))) {
        for (const id of bookWithDescendants(books, named.id)) found.add(id)
      }
      ids = [...found]
    }
    if (ids.length > 0) sets.push({ kind: c.field, ids, negate: c.negate })
    else if (!c.negate) return null
  }
  return { text, sets, pinned: filter?.kind === 'pinned' }
}

/**
 * `query` leaving out the notes in Templates (see templates.ts), which
 * search never finds. A query a notebook narrows already does; one that
 * excludes notebooks excludes Templates with them; any other gets one more
 * condition. So the longest query (every clause, a filter, no notebook)
 * stays within the conditions storage accepts.
 */
export function excludeTemplates(query: NoteQuery): NoteQuery {
  const books = query.sets.filter((s) => s.kind === 'book')
  if (books.some((s) => !s.negate)) {
    // A Devot from before templates could nest Templates in a notebook; its
    // notes still stay out. A narrowing notebook is never Templates itself.
    const drop = (ids: string[]) => ids.filter((id) => id !== TEMPLATES_BOOK_ID)
    return {
      ...query,
      sets: query.sets.map((s) =>
        s.kind === 'book' && !s.negate && s.ids.includes(TEMPLATES_BOOK_ID)
          ? { ...s, ids: drop(s.ids) }
          : s,
      ),
    }
  }
  const excluded = books.find((s) => s.negate)
  const sets = excluded
    ? query.sets.map((s) => (s === excluded ? { ...s, ids: [...s.ids, TEMPLATES_BOOK_ID] } : s))
    : [...query.sets, { kind: 'book' as const, ids: [TEMPLATES_BOOK_ID], negate: true }]
  return { ...query, sets }
}

/** Text long enough for the trigram index. */
export const indexable = (value: string) => [...value].length >= 3

const FTS_COLUMN = { any: '', title: 'title : ', body: 'body_md : ' } as const

/** An FTS5 query matching every condition's value as a literal string, in its column. */
export function ftsQuery(conditions: readonly Pick<TextCondition, 'field' | 'value'>[]): string {
  return conditions
    .map((c) => `${FTS_COLUMN[c.field]}"${c.value.replaceAll('"', '""')}"`)
    .join(' AND ')
}

/** Storage's excerpt (a window of the body) as one tidy line. */
export function tidyExcerpt(raw: string): string {
  const ellipsis = '…'
  const cut = raw.startsWith(ellipsis)
  const body = (cut ? raw.slice(1) : raw).replace(/\s+/g, ' ').trim()
  return body && cut ? `${ellipsis}${body}` : body
}
