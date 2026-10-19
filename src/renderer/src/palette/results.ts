// What the command palette lists for what is typed. With nothing typed the
// root lists the sources; a key and a space (`b `) scope the palette to one
// source (`:` takes a digit as well: `:12` goes to line 12); any other text at the root matches commands, notebooks, tags and
// notes together (fuzzy, see core/fuzzy.ts), grouped by kind.
import { fuzzyRank } from '../../../core/fuzzy'
import type { TagColor } from '../../../core/storage'

export type PaletteSource = 'command' | 'book' | 'tag' | 'outline' | 'line' | 'note'

export const PALETTE_SOURCES: readonly PaletteSource[] = [
  'command',
  'book',
  'tag',
  'outline',
  'line',
  'note',
]

export const SOURCE_KEYS: Readonly<Record<PaletteSource, string | undefined>> = {
  command: '>',
  book: 'b',
  tag: 't',
  outline: '#',
  line: ':',
  note: undefined,
}

export type PaletteKind = PaletteSource | 'source'

export const PALETTE_KINDS: readonly PaletteKind[] = ['command', 'book', 'tag', 'note']

export interface PaletteState {
  scope: PaletteSource | null
  query: string
}

export const ROOT: PaletteState = { scope: null, query: '' }

// `:` scopes with a space or a digit after it, so `:todo:` stays a search.
const SCOPE_PREFIX = /^(?:(>|b|t|#) |(:)(?: |(?=\d)))(.*)$/s

/**
 * The state after the field's text becomes `text`. At the root a source's
 * key and a space scope the palette to it (`b ` and the rest of the text as
 * the query); anywhere else the text is the query.
 */
export function typeInto(state: PaletteState, text: string): PaletteState {
  if (state.scope === null) {
    const match = SCOPE_PREFIX.exec(text)
    const key = match?.[1] ?? match?.[2]
    const scope = PALETTE_SOURCES.find((source) => SOURCE_KEYS[source] === key)
    if (match && scope) return { scope, query: match[3] ?? '' }
  }
  return { ...state, query: text }
}

/**
 * Escape steps back: a query is cleared (the scope stays), a scope returns
 * to the root, and at the root with nothing typed the palette closes (null).
 */
export function escapeStep(state: PaletteState): PaletteState | null {
  if (state.query !== '') return { ...state, query: '' }
  if (state.scope !== null) return ROOT
  return null
}

/**
 * The line a Go to Line query names in a note of `lines` lines (past the
 * last: the last); null unless the query is a whole number of 1 or more.
 */
export function lineOfQuery(query: string, lines: number): number | null {
  const text = query.trim()
  if (!/^\d+$/.test(text) || lines < 1) return null
  const n = Number.parseInt(text, 10)
  return n < 1 ? null : Math.min(n, lines)
}

export interface PaletteEntry {
  kind: PaletteKind
  id: string
  label: string
  detail?: string
  shortcut?: string
  description?: string
  /** An outline entry or a line to go to: its line in the note (1 is the first). */
  line?: number
  /** An outline entry: a heading's level (1 to 6); 0 for a task. */
  level?: number
  depth?: number
  done?: boolean
  bookIcon?: { icon: string | null; color: TagColor | null }
}

export interface PaletteResult extends PaletteEntry {
  ranges: [number, number][]
}

export interface PaletteGroup {
  kind: PaletteKind
  results: PaletteResult[]
}

const QUERY_LIMIT: Readonly<Record<PaletteKind, number>> = {
  command: 50,
  book: 20,
  tag: 20,
  note: 20,
  outline: 200,
  line: 1,
  source: 10,
}

const BROWSE_LIMIT: Readonly<Record<PaletteKind, number>> = {
  command: Infinity,
  book: 5,
  tag: 5,
  note: 5,
  outline: Infinity,
  line: 1,
  source: Infinity,
}

const SCOPED_BROWSE_LIMIT: Readonly<Record<PaletteKind, number>> = {
  ...BROWSE_LIMIT,
  book: 100,
  tag: 100,
  note: 30,
}

/**
 * The results for `query`, a group per kind that has any. Within a group the
 * best match comes first; the group whose best match is best comes first (by
 * kind on a tie). With nothing typed every group keeps its entries' order.
 */
export function paletteGroups(
  query: string,
  entries: Readonly<Record<PaletteKind, readonly PaletteEntry[]>>,
  kinds: readonly PaletteKind[] = PALETTE_KINDS,
  browseLimit: Readonly<Record<PaletteKind, number>> = BROWSE_LIMIT,
): PaletteGroup[] {
  const browsing = query.trim() === ''
  const groups = kinds
    .map((kind) => {
      const ranked = fuzzyRank(query, entries[kind], (e) => e.label).slice(
        0,
        (browsing ? browseLimit : QUERY_LIMIT)[kind],
      )
      return {
        kind,
        best: ranked[0]?.score ?? -Infinity,
        results: ranked.map((r): PaletteResult => ({ ...r.item, ranges: r.ranges })),
      }
    })
    .filter((g) => g.results.length > 0)
  if (!browsing) groups.sort((a, b) => b.best - a.best)
  return groups.map(({ kind, results }) => ({ kind, results }))
}

/**
 * What the palette lists in `state`: the sources at the root with nothing
 * typed; one source's matches when scoped (an outline keeps document order
 * until something is typed); every kind's matches for text typed at the root.
 */
export function paletteResults(
  state: PaletteState,
  entries: Readonly<Record<PaletteKind, readonly PaletteEntry[]>>,
): PaletteGroup[] {
  // The line to go to is made from the query, not matched against it.
  if (state.scope === 'line') {
    const results = entries.line.map((e): PaletteResult => ({ ...e, ranges: [] }))
    return results.length > 0 ? [{ kind: 'line', results }] : []
  }
  if (state.scope !== null) {
    return paletteGroups(state.query, entries, [state.scope], SCOPED_BROWSE_LIMIT)
  }
  if (state.query.trim() === '') return paletteGroups('', entries, ['source'])
  return paletteGroups(state.query, entries)
}
