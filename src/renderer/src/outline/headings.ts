import { outlineEntries } from '../palette/entries'

export interface OutlineHeading {
  /** Stays the same when lines above it come and go: its level and text, and which of that pair it is. */
  key: string
  line: number
  level: number
  label: string
  /** The nearest heading above with a lower level, or -1. */
  parent: number
  hasChildren: boolean
}

export function outlineHeadings(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  const seen = new Map<string, number>()
  const open: number[] = []
  for (const entry of outlineEntries(markdown)) {
    const level = entry.level ?? 0
    if (level === 0 || entry.line === undefined) continue
    while (open.length > 0 && headings[open[open.length - 1]!]!.level >= level) open.pop()
    const parent = open[open.length - 1] ?? -1
    if (parent >= 0) headings[parent]!.hasChildren = true
    const same = `${level}:${entry.label}`
    const nth = seen.get(same) ?? 0
    seen.set(same, nth + 1)
    open.push(headings.length)
    headings.push({
      key: `${same}:${nth}`,
      line: entry.line,
      level,
      label: entry.label,
      parent,
      hasChildren: false,
    })
  }
  return headings
}

/** The heading that holds `line`: the last one at or above it, or -1 before the first. */
export function currentHeading(headings: readonly OutlineHeading[], line: number): number {
  let lo = 0
  let hi = headings.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (headings[mid]!.line <= line) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

/** The indexes shown: every heading whose ancestors are all unfolded. */
export function shownHeadings(
  headings: readonly OutlineHeading[],
  folded: ReadonlySet<string>,
): number[] {
  const hidden: boolean[] = []
  const shown: number[] = []
  headings.forEach((heading, i) => {
    const above = heading.parent
    hidden[i] = above >= 0 && (hidden[above]! || folded.has(headings[above]!.key))
    if (!hidden[i]) shown.push(i)
  })
  return shown
}

/** The heading to show as current when it is folded away: its nearest ancestor that is shown. */
export function shownAncestor(
  headings: readonly OutlineHeading[],
  shown: readonly number[],
  index: number,
): number {
  const visible = new Set(shown)
  for (let i = index; i >= 0; i = headings[i]!.parent) if (visible.has(i)) return i
  return -1
}
