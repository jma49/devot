// Seeded random notes and edits, for tests that check what is kept across an
// edit against what reading the whole note again finds. A seed reads a failure again.

const LINES = [
  '',
  '',
  'Some text',
  'More text with ![a](https://example.com/a.png) inside',
  '![a](https://example.com/a.png)',
  '$$',
  'x^2',
  '$$ y $$',
  '```mermaid',
  '```math',
  '```',
  '~~~',
  '````',
  'graph TD',
  '<iframe src="https://example.com"></iframe>',
  'https://www.youtube.com/watch?v=abcdefghijk',
  '- item',
  '> quote',
  '    indented',
  '---',
  'title: x',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  'A note[^n] here',
  '[^n]: its text',
  '[^m]: more[^n]',
  '`[^n]` in code',
  '\\[^n] escaped',
]

const PIECES = ['x', ' ', '|', '$', '`', '\n', '[^n]', '[^', ']', '!', '-', '\\']

export type Random = () => number

export function seeded(seed: number): Random {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

export const pick = <T>(next: Random, of: readonly T[]): T => of[Math.floor(next() * of.length)]!

export function randomLines(next: Random, count: number): string {
  return Array.from({ length: count }, () => pick(next, LINES)).join('\n')
}

export function randomNote(next: Random): string {
  return randomLines(next, 4 + Math.floor(next() * 30))
}

/** Lines replaced, inserted or deleted, or a character typed, somewhere in `doc`. */
export function randomChange(
  next: Random,
  doc: string,
): { from: number; to: number; insert: string } {
  const from = Math.floor(next() * (doc.length + 1))
  const kind = next()
  const to =
    kind < 0.6 && kind >= 0.15 ? from : Math.min(doc.length, from + Math.floor(next() * 40))
  const insert =
    kind < 0.15
      ? ''
      : kind < 0.4
        ? pick(next, PIECES)
        : randomLines(next, 1 + Math.floor(next() * 3))
  return { from, to, insert }
}
