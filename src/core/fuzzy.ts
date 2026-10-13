// Fuzzy matching for quick pickers (the command palette): the query's
// letters must appear in the text in order, not necessarily together. Matches
// at word starts and in runs score higher, so "nb" finds "New Book" before
// "unbox". Case and accents are ignored; spaces in the query are skipped.

/** A match: its score (higher is better) and the matched runs of the text. */
export interface FuzzyMatch {
  score: number
  /** `[from, to)` offsets into the text (UTF-16 code units), in order. */
  ranges: [number, number][]
}

/** Only this many characters of a text are searched. */
const MAX_TEXT = 256
/** Only this many characters of a query are used. */
const MAX_QUERY = 64

const MATCH = 16
const FIRST = 12
const BOUNDARY = 10
const CAMEL = 8
const CONSECUTIVE = 12
const GAP_OPEN = 3
const LEADING_MAX = 8
const NONE = -Infinity

/** One character, without case and accents, for comparing. */
function fold(char: string): string {
  return char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

const WORD = /[\p{L}\p{N}]/u
const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u

/** The bonus for matching at `chars[j]`: the start of the text or of a word. */
function bonus(chars: string[], j: number): number {
  if (j === 0) return FIRST
  const prev = chars[j - 1] ?? ''
  const cur = chars[j] ?? ''
  if (!WORD.test(prev) && WORD.test(cur)) return BOUNDARY
  if (LOWER.test(prev) && UPPER.test(cur)) return CAMEL
  return 0
}

/**
 * Where `query` matches `text`, or null. The best match is found by dynamic
 * programming: each query letter goes where the total score is highest.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = Array.from(query.replace(/\s+/g, '')).slice(0, MAX_QUERY).map(fold)
  if (needle.length === 0) return { score: 0, ranges: [] }
  const chars = Array.from(text).slice(0, MAX_TEXT)
  const folded = chars.map(fold)
  const n = chars.length
  const m = needle.length
  if (m > n) return null
  // A quick check that the letters are there at all.
  let at = 0
  for (const c of folded) if (c === needle[at] && ++at === m) break
  if (at < m) return null

  const bonuses = chars.map((_, j) => bonus(chars, j))
  // back[i][j]: where letter i - 1 went when letter i is at j.
  const back: Int32Array[] = []
  let prev = new Float64Array(n).fill(NONE)
  for (let j = 0; j < n; j++) {
    if (folded[j] === needle[0]) prev[j] = MATCH + bonuses[j]! - Math.min(j, LEADING_MAX)
  }
  for (let i = 1; i < m; i++) {
    const cur = new Float64Array(n).fill(NONE)
    const from = new Int32Array(n).fill(-1)
    // The best `prev[k] + k` for k <= j - 2: a gap costs one point a character.
    let bestGap = NONE
    let bestGapAt = -1
    for (let j = 1; j < n; j++) {
      const k = j - 2
      if (k >= 0 && prev[k]! + k > bestGap) {
        bestGap = prev[k]! + k
        bestGapAt = k
      }
      if (folded[j] !== needle[i]) continue
      const run = prev[j - 1]! + CONSECUTIVE
      const gap = bestGap - GAP_OPEN - (j - 2)
      const base = Math.max(run, gap)
      if (base === NONE) continue
      cur[j] = MATCH + bonuses[j]! + base
      from[j] = run >= gap ? j - 1 : bestGapAt
    }
    back.push(from)
    prev = cur
  }

  let end = -1
  let score = NONE
  for (let j = 0; j < n; j++) {
    if (prev[j]! > score) {
      score = prev[j]!
      end = j
    }
  }
  if (end < 0) return null
  const positions = [end]
  for (let i = m - 2; i >= 0; i--) positions.unshift(back[i]![positions[0]!]!)

  // Character positions to code unit ranges, joining neighbours.
  const offsets: number[] = []
  let offset = 0
  for (const c of chars) {
    offsets.push(offset)
    offset += c.length
  }
  const ranges: [number, number][] = []
  for (const p of positions) {
    const from = offsets[p]!
    const to = from + chars[p]!.length
    const last = ranges.at(-1)
    if (last && last[1] === from) last[1] = to
    else ranges.push([from, to])
  }
  return { score, ranges }
}

/** A ranked item: what matched and how well. */
export interface Ranked<T> extends FuzzyMatch {
  item: T
}

/**
 * The items whose text matches `query`, best first; on a tie the shorter text,
 * then the given order. An empty query keeps every item in the given order.
 */
export function fuzzyRank<T>(query: string, items: readonly T[], text: (item: T) => string) {
  const ranked: (Ranked<T> & { index: number; length: number })[] = []
  items.forEach((item, index) => {
    const label = text(item)
    const match = fuzzyMatch(query, label)
    if (match) ranked.push({ item, index, length: label.length, ...match })
  })
  if (query.trim() !== '') {
    ranked.sort((a, b) => b.score - a.score || a.length - b.length || a.index - b.index)
  }
  return ranked.map(({ item, score, ranges }): Ranked<T> => ({ item, score, ranges }))
}
