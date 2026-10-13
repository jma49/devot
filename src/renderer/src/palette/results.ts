// What the command palette lists for a query: commands, notebooks, tags and
// notes that match it (fuzzy, see core/fuzzy.ts), grouped by kind.
import { fuzzyRank } from '../../../core/fuzzy'

export type PaletteKind = 'command' | 'book' | 'tag' | 'note'

/** The kinds in the order they show when nothing is typed (and on a tie). */
export const PALETTE_KINDS: readonly PaletteKind[] = ['command', 'book', 'tag', 'note']

/** Something the palette can list. */
export interface PaletteEntry {
  kind: PaletteKind
  id: string
  /** What is matched and shown. */
  label: string
  /** Shown after the label, dimmed: a notebook's parent, a note's notebook. */
  detail?: string
  /** A command's key, as macOS shows it. */
  shortcut?: string
}

export interface PaletteResult extends PaletteEntry {
  /** The matched parts of the label, `[from, to)`. */
  ranges: [number, number][]
}

export interface PaletteGroup {
  kind: PaletteKind
  results: PaletteResult[]
}

/** At most this many results of each kind for a query. */
const QUERY_LIMIT: Readonly<Record<PaletteKind, number>> = {
  command: 50,
  book: 20,
  tag: 20,
  note: 20,
}

/** With nothing typed: every command, and a few of each other kind. */
const BROWSE_LIMIT: Readonly<Record<PaletteKind, number>> = {
  command: Infinity,
  book: 5,
  tag: 5,
  note: 5,
}

/**
 * The results for `query`, a group per kind that has any. Within a group the
 * best match comes first; the group whose best match is best comes first (by
 * kind on a tie). With nothing typed every group keeps its entries' order.
 */
export function paletteGroups(
  query: string,
  entries: Readonly<Record<PaletteKind, readonly PaletteEntry[]>>,
): PaletteGroup[] {
  const browsing = query.trim() === ''
  const groups = PALETTE_KINDS.map((kind) => {
    const ranked = fuzzyRank(query, entries[kind], (e) => e.label).slice(
      0,
      (browsing ? BROWSE_LIMIT : QUERY_LIMIT)[kind],
    )
    return {
      kind,
      best: ranked[0]?.score ?? -Infinity,
      results: ranked.map((r): PaletteResult => ({ ...r.item, ranges: r.ranges })),
    }
  }).filter((g) => g.results.length > 0)
  if (!browsing) groups.sort((a, b) => b.best - a.best)
  return groups.map(({ kind, results }) => ({ kind, results }))
}
