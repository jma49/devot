import { TEMPLATES_BOOK_ID } from '../../core/books'
import { UUID_V7 } from '../../core/ids'
import { parseSearch, searchValue, statusFromName, type SearchField } from '../../core/search'
import {
  NOTE_STATUSES,
  type BookRecord,
  type NoteStatus,
  type TagColorValue,
  type TagRecord,
} from '../../core/storage'
import { sameName } from '../../core/tagNames'
import { t, type MessageKey } from './i18n'
import type { IconName } from './icons/symbols'

export type SearchPillField = 'book' | 'bookId' | 'tag' | 'tagId' | 'hashtag' | 'status' | 'pinned'

export interface SearchPill {
  id: string
  raw: string
  field: SearchPillField
  key: string
  value: string
  negate: boolean
  tagColor?: TagColorValue | null
  start: number
  end: number
}

export interface SearchSuggestion {
  id: string
  clause: string
  label: string
  prefix: string
  detail?: string
  icon?: IconName
  tagColor?: TagColorValue | null
  status?: NoteStatus
}

export interface SearchSuggestionMatch {
  start: number
  end: number
  items: SearchSuggestion[]
}

export interface SearchFieldContext {
  books?: readonly BookRecord[] | undefined
  tags?: readonly TagRecord[] | undefined
}

const SPACE = /\s/
const PILL_QUALIFIER = /^(in|book|bookId|tag|tagId|is|status|pinned):/i
const SUGGEST_QUALIFIER = /^(in|book|tag|is|status|pinned):(.*)$/i

const QUALIFIER_FIELD: Readonly<Record<string, SearchPillField>> = {
  in: 'book',
  book: 'book',
  bookid: 'bookId',
  tag: 'tag',
  tagid: 'tagId',
  is: 'status',
  status: 'status',
  pinned: 'pinned',
}

const STATUS_ICON: Readonly<Record<NoteStatus, IconName>> = {
  none: 'status.none',
  active: 'status.active',
  on_hold: 'status.onHold',
  completed: 'status.completed',
  dropped: 'status.dropped',
}

function pinnedBool(value: string): 'true' | 'false' | null {
  const key = value.trim().toLowerCase()
  if (key === 'true' || key === 'yes' || key === '1') return 'true'
  if (key === 'false' || key === 'no' || key === '0') return 'false'
  return null
}

function closeSingle(text: string, from: number): number {
  for (let i = text.indexOf("'", from + 1); i >= 0; i = text.indexOf("'", i + 1)) {
    if (i + 1 === text.length || SPACE.test(text[i + 1]!)) return i
  }
  return -1
}

function readClauseValue(
  text: string,
  at: number,
): { value: string; nextAt: number; closed: boolean } {
  const ch = text[at]
  if (ch === '"') {
    const close = text.indexOf('"', at + 1)
    if (close < 0) return { value: text.slice(at + 1), nextAt: text.length, closed: false }
    return { value: text.slice(at + 1, close), nextAt: close + 1, closed: true }
  }
  if (ch === "'") {
    const close = closeSingle(text, at)
    if (close < 0) return { value: text.slice(at + 1), nextAt: text.length, closed: false }
    return { value: text.slice(at + 1, close), nextAt: close + 1, closed: true }
  }
  let end = at
  while (end < text.length && !SPACE.test(text[end]!)) end += 1
  return { value: text.slice(at, end), nextAt: end, closed: true }
}

/**
 * Splits leading whitespace-terminated filter qualifiers into removable pills while keeping any
 * active draft (or single unspaced clause) inside the text input so `value` stays synced cleanly.
 */
export function splitSearchPills(
  value: string,
  context: SearchFieldContext = {},
): { pills: SearchPill[]; draft: string } {
  const pills: SearchPill[] = []
  let at = 0
  let lastEnd = 0

  while (at < value.length) {
    while (at < value.length && SPACE.test(value[at]!)) at += 1
    if (at >= value.length) break

    const start = at
    const negate = value[at] === '-'
    if (negate) at += 1
    if (at >= value.length) break

    let field: SearchPillField | undefined
    let key = ''
    if (value[at] === '#') {
      field = 'hashtag'
      key = '#'
      at += 1
    } else {
      const m = PILL_QUALIFIER.exec(value.slice(at, at + 12))
      const mapped = m?.[1] ? QUALIFIER_FIELD[m[1].toLowerCase()] : undefined
      if (!m || !mapped) break
      field = mapped
      key = m[1]!
      at += m[0].length
    }

    const parsed = readClauseValue(value, at)
    if (!parsed.closed) break
    at = parsed.nextAt
    // Completed clauses always end at whitespace so incomplete or unspaced tokens stay editable.
    if (at >= value.length || !SPACE.test(value[at]!)) break

    const clean = parsed.value.trim()
    if (!clean) break

    let tagColor: TagColorValue | null | undefined
    if (field === 'status' && statusFromName(clean) === null) break
    if (field === 'pinned' && pinnedBool(clean) === null) break
    if ((field === 'bookId' || field === 'tagId') && !UUID_V7.test(clean.toLowerCase())) break
    if (field === 'hashtag') {
      const matched = context.tags?.find((tag) => sameName(tag.name, clean))
      if (!matched) break
      tagColor = matched.color
    } else if (field === 'tag') {
      tagColor = context.tags?.find((tag) => sameName(tag.name, clean))?.color
    } else if (field === 'tagId') {
      const id = clean.toLowerCase()
      tagColor = context.tags?.find((tag) => tag.id.toLowerCase() === id)?.color
    }

    pills.push({
      id: `${start}:${value.slice(start, at)}`,
      raw: value.slice(start, at),
      field,
      key,
      value: clean,
      negate,
      ...(tagColor ? { tagColor } : {}),
      start,
      end: at,
    })
    lastEnd = at
  }

  if (pills.length === 0) return { pills: [], draft: value }
  // Consume the single delimiter space separating the completed pill prefix from the draft input.
  const draft = value[lastEnd] && SPACE.test(value[lastEnd]!) ? value.slice(lastEnd + 1) : ''
  return { pills, draft }
}

export function composeSearchValue(
  pills: readonly Pick<SearchPill, 'raw'>[],
  draft: string,
): string {
  if (pills.length === 0) return draft
  return `${pills.map((p) => p.raw).join(' ')} ${draft}`
}

export function removeSearchPill(value: string, target: Pick<SearchPill, 'start' | 'end'>): string {
  const before = value.slice(0, target.start).trimEnd()
  const after = value.slice(target.end).replace(/^\s+/, '')
  if (!before) return after
  return after ? `${before} ${after}` : `${before} `
}

/**
 * On Backspace at caret 0: unwraps an isolated last pill back into the input when the draft is
 * empty, or removes the last pill ahead of existing draft text.
 */
export function backspaceSearchPill(
  _value: string,
  pills: readonly SearchPill[],
  draft: string,
): string {
  const last = pills.at(-1)
  if (!last) return draft
  const rest = pills.slice(0, -1)
  if (draft === '')
    return rest.length === 0 ? last.raw : `${rest.map((p) => p.raw).join(' ')} ${last.raw}`
  return composeSearchValue(rest, draft)
}

function tokenAtCaret(
  text: string,
  caret: number,
): { start: number; end: number; raw: string } | null {
  if (caret < 0 || caret > text.length) return null
  let at = 0
  while (at < caret) {
    while (at < caret && SPACE.test(text[at]!)) at += 1
    if (at >= caret) return null
    const start = at
    let qualified = false
    if (text[at] === '-') at += 1
    if (at < caret && text[at] === '#') {
      qualified = true
      at += 1
    } else {
      const m = PILL_QUALIFIER.exec(text.slice(at, Math.min(caret, at + 12)))
      if (m) {
        qualified = true
        at += m[0].length
      }
    }
    const quote = at < caret ? text[at] : undefined
    const close =
      quote === '"' ? text.indexOf('"', at + 1) : quote === "'" ? closeSingle(text, at) : -1
    if (quote === '"' || (quote === "'" && (qualified || close >= 0))) {
      if (close < 0 || close >= caret) {
        if (caret === text.length || SPACE.test(text[caret]!) || close === caret - 1) {
          return { start, end: caret, raw: text.slice(start, caret) }
        }
        return null
      }
      at = close + 1
      while (at < text.length && !SPACE.test(text[at]!)) at += 1
    } else {
      while (at < text.length && !SPACE.test(text[at]!)) at += 1
    }
    if (at === caret) return { start, end: caret, raw: text.slice(start, caret) }
    if (at > caret) return null
  }
  return null
}

function namedOrIdClause(
  prefix: string,
  idPrefix: string,
  field: SearchField,
  name: string,
  id: string,
  negate: boolean,
): { clause: string; prefix: string } {
  const neg = negate ? '-' : ''
  const fullPrefix = `${neg}${prefix}`
  const named = `${fullPrefix}${searchValue(name)}`
  const [clause, ...rest] = parseSearch(named)
  const roundTrips =
    rest.length === 0 &&
    clause?.field === field &&
    clause.value === name &&
    clause.negate === negate
  return roundTrips
    ? { clause: named, prefix: fullPrefix }
    : { clause: `${neg}${idPrefix}${id}`, prefix: `${neg}${idPrefix}` }
}

function stripOpenQuote(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) return raw.slice(1)
  return raw
}

function rankMatch<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  extraOf?: (item: T) => string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice(0, 20)
  const prefix: T[] = []
  const substr: T[] = []
  for (const item of items) {
    const primary = textOf(item).toLowerCase()
    const secondary = extraOf ? extraOf(item).toLowerCase() : ''
    if (primary.startsWith(q) || secondary.startsWith(q)) prefix.push(item)
    else if (primary.includes(q) || secondary.includes(q)) substr.push(item)
  }
  return [...prefix, ...substr].slice(0, 20)
}

/** Suggests filter completions for the token ending at `caret` in `draft`. */
export function searchSuggestions(
  draft: string,
  caret: number,
  context: SearchFieldContext = {},
): SearchSuggestionMatch {
  const tok = tokenAtCaret(draft, caret)
  if (!tok) return { start: caret, end: caret, items: [] }

  const negate = tok.raw.startsWith('-')
  const body = negate ? tok.raw.slice(1) : tok.raw
  const neg = negate ? '-' : ''

  if (body.startsWith('#')) {
    const fragment = stripOpenQuote(body.slice(1))
    const tags = rankMatch(context.tags ?? [], fragment, (tag) => tag.name)
    return {
      start: tok.start,
      end: tok.end,
      items: tags.map((tag) => {
        const ref = namedOrIdClause('#', 'tagId:', 'hashtag', tag.name, tag.id, negate)
        return {
          id: `hashtag:${neg}${tag.id}`,
          clause: ref.clause,
          prefix: ref.prefix,
          label: tag.name,
          tagColor: tag.color,
        }
      }),
    }
  }

  const m = SUGGEST_QUALIFIER.exec(body)
  if (!m) return { start: caret, end: caret, items: [] }
  const qual = m[1]!
  const key = qual.toLowerCase()
  const fragment = stripOpenQuote(m[2]!)

  if (key === 'in' || key === 'book') {
    const liveBooks = (context.books ?? []).filter((b) => b.id !== TEMPLATES_BOOK_ID)
    const books = rankMatch(liveBooks, fragment, (b) => b.name)
    return {
      start: tok.start,
      end: tok.end,
      items: books.map((book) => {
        const ref = namedOrIdClause(`${qual}:`, 'bookId:', 'book', book.name, book.id, negate)
        return {
          id: `book:${neg}${qual}:${book.id}`,
          clause: ref.clause,
          prefix: ref.prefix,
          label: book.name,
          icon: 'notebook',
        }
      }),
    }
  }

  if (key === 'tag') {
    const tags = rankMatch(context.tags ?? [], fragment, (tag) => tag.name)
    return {
      start: tok.start,
      end: tok.end,
      items: tags.map((tag) => {
        const ref = namedOrIdClause(`${qual}:`, 'tagId:', 'tag', tag.name, tag.id, negate)
        return {
          id: `tag:${neg}${qual}:${tag.id}`,
          clause: ref.clause,
          prefix: ref.prefix,
          label: tag.name,
          tagColor: tag.color,
        }
      }),
    }
  }

  if (key === 'is' || key === 'status') {
    const labelOf = (s: NoteStatus) => t(`status.${s}` as MessageKey)
    const statuses = rankMatch(NOTE_STATUSES, fragment, (s) => s, labelOf)
    return {
      start: tok.start,
      end: tok.end,
      items: statuses.map((status) => ({
        id: `status:${neg}${qual}:${status}`,
        clause: `${neg}${qual}:${status}`,
        prefix: `${neg}${qual}:`,
        label: status,
        detail: labelOf(status),
        icon: STATUS_ICON[status],
        status,
      })),
    }
  }

  const bools = rankMatch(['true', 'false'] as const, fragment, (v) => v)
  return {
    start: tok.start,
    end: tok.end,
    items: bools.map((val) => ({
      id: `pinned:${neg}${val}`,
      clause: `${neg}pinned:${val}`,
      prefix: `${neg}pinned:`,
      label: val,
      icon: 'notes.pinned',
    })),
  }
}

/** Accepts `suggestion`, hoisting the completed filter clause into the leading pill strip. */
export function applySearchSuggestion(
  pills: readonly SearchPill[],
  draft: string,
  match: SearchSuggestionMatch,
  suggestion: SearchSuggestion,
): string {
  const before = draft.slice(0, match.start).trimEnd()
  const after = draft.slice(match.end).trimStart()
  const remaining = [before, after].filter(Boolean).join(' ')
  return composeSearchValue([...pills, { raw: suggestion.clause }], remaining)
}
