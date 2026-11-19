// How the selection toolbar's button groups fall into rows when they do not
// fit one. Pure, so the rules can be tested without an editor.

export interface RowPlan {
  /** How many groups each row holds, in order. */
  rows: number[]
  /** The widest row's width, or the room when a single group is wider. */
  width: number
}

interface Candidate {
  rows: number[]
  widest: number
  spread: number
}

/** Narrower widest row first, then alike rows; a tie goes to the cut with the longer first row. */
function better(a: Candidate, b: Candidate): boolean {
  if (a.widest !== b.widest) return a.widest < b.widest
  if (a.spread !== b.spread) return a.spread < b.spread
  const at = a.rows.findIndex((count, i) => count !== b.rows[i])
  return at >= 0 && a.rows[at]! > b.rows[at]!
}

function candidates(widths: readonly number[], separator: number, room: number): Candidate[] {
  const n = widths.length
  const out: Candidate[] = []
  for (let cuts = 0; cuts < 2 ** (n - 1); cuts++) {
    const rows: number[] = []
    const sizes: number[] = []
    let count = 0
    let size = 0
    for (let i = 0; i < n; i++) {
      size += (count > 0 ? separator : 0) + widths[i]!
      count++
      if (i === n - 1 || cuts & (1 << i)) {
        rows.push(count)
        sizes.push(size)
        count = 0
        size = 0
      }
    }
    const widest = Math.max(...sizes)
    if (widest <= room) {
      out.push({ rows, widest, spread: sizes.reduce((sum, s) => sum + s * s, 0) })
    }
  }
  return out
}

/**
 * The fewest rows the groups fit in, cut only between groups (where a
 * separator stands) with the rows as alike as they can be: the cut that gives
 * the narrowest widest row, then the one whose rows differ least. A room
 * narrower than the widest group puts each group on a row of its own, as wide
 * as the room, and the buttons of the group wrap inside it.
 */
export function planRows(widths: readonly number[], separator: number, room: number): RowPlan {
  const n = widths.length
  if (n === 0) return { rows: [], width: 0 }
  const best = new Map<number, Candidate>()
  for (const c of candidates(widths, separator, room)) {
    const known = best.get(c.rows.length)
    if (!known || better(c, known)) best.set(c.rows.length, c)
  }
  const fewest = Math.min(...best.keys())
  const chosen = best.get(fewest)
  if (!chosen || !Number.isFinite(fewest)) {
    return { rows: widths.map(() => 1), width: Math.max(0, room) }
  }
  return { rows: chosen.rows, width: chosen.widest }
}

/** The indices of the groups that start a row, past the first row: the separators before them break the line. */
export function breaksBefore(rows: readonly number[]): Set<number> {
  const breaks = new Set<number>()
  let at = 0
  for (const count of rows.slice(0, -1)) {
    at += count
    breaks.add(at)
  }
  return breaks
}
