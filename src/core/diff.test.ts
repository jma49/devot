import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { foldUnchanged, lineDiff, textEdits, type DiffLine } from './diff'
import { replaceRanges } from './text'

const side = (lines: DiffLine[], drop: DiffLine['kind']) =>
  lines.filter((l) => l.kind !== drop).map((l) => l.text)

function lcs(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0)
  for (const x of a) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]!)
      diagonal = above
    }
  }
  return row[b.length]!
}

describe('lineDiff', () => {
  it('marks the lines removed from and added to the first text', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ])
  })

  it('treats an empty text as no lines', () => {
    expect(lineDiff('', '')).toEqual([])
    expect(lineDiff('', 'x')).toEqual([{ kind: 'added', text: 'x' }])
    expect(lineDiff('x', '')).toEqual([{ kind: 'removed', text: 'x' }])
  })

  it('rebuilds both texts and keeps a longest common run of lines', () => {
    const text = fc
      .array(fc.constantFrom('a', 'b', 'c', '', 'd e'), { maxLength: 14 })
      .map((lines) => lines.join('\n'))
    fc.assert(
      fc.property(text, text, (from, to) => {
        const lines = lineDiff(from, to)
        const split = (t: string) => (t === '' ? [] : t.split('\n'))
        expect(side(lines, 'added')).toEqual(split(from))
        expect(side(lines, 'removed')).toEqual(split(to))
        expect(lines.filter((l) => l.kind === 'same')).toHaveLength(lcs(split(from), split(to)))
      }),
    )
  })

  it('stays correct, if not minimal, for texts too different to compare line by line', () => {
    const from = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n')
    const to = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n')
    const lines = lineDiff(`top\n${from}\nend`, `top\n${to}\nend`)
    expect(lines[0]).toEqual({ kind: 'same', text: 'top' })
    expect(lines.at(-1)).toEqual({ kind: 'same', text: 'end' })
    expect(side(lines, 'added').join('\n')).toBe(`top\n${from}\nend`)
    expect(side(lines, 'removed').join('\n')).toBe(`top\n${to}\nend`)
  })
})

describe('foldUnchanged', () => {
  const same = (n: number, from = 0): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'same', text: `s${from + i}` }))

  it('keeps a few lines of context around changes and folds the rest', () => {
    const lines: DiffLine[] = [...same(10), { kind: 'added', text: 'new' }, ...same(10, 10)]
    expect(foldUnchanged(lines, 2)).toEqual([
      { kind: 'skipped', count: 8 },
      { kind: 'same', text: 's8' },
      { kind: 'same', text: 's9' },
      { kind: 'added', text: 'new' },
      { kind: 'same', text: 's10' },
      { kind: 'same', text: 's11' },
      { kind: 'skipped', count: 8 },
    ])
  })

  it('never folds a single line, which would take as much room as the line', () => {
    const lines: DiffLine[] = [...same(3), { kind: 'removed', text: 'old' }]
    expect(foldUnchanged(lines, 2)).toEqual(lines)
  })

  it('folds everything when nothing changed', () => {
    expect(foldUnchanged(same(5), 3)).toEqual([{ kind: 'skipped', count: 5 }])
    expect(foldUnchanged([], 3)).toEqual([])
  })
})

describe('textEdits', () => {
  it('replaces only the characters that differ, line run by line run', () => {
    const from = 'Groceries\n\nMilk.\n\nCall the bank.\n\nWater the plants.\n'
    const to = 'Shopping\n\nMilk.\n\nCall the bank.\n\nWater the ferns.\n'
    expect(textEdits(from, to)).toEqual([
      { start: 0, end: 9, text: 'Shopping' },
      { start: 44, end: 49, text: 'fern' },
    ])
  })

  it('makes no edit between equal texts', () => {
    expect(textEdits('', '')).toEqual([])
    expect(textEdits('a\nb', 'a\nb')).toEqual([])
  })

  it('handles a last line without a line feed', () => {
    expect(replaceRanges('a\nb', textEdits('a\nb', 'a\nb\nc'))).toBe('a\nb\nc')
    expect(replaceRanges('a\nb\n', textEdits('a\nb\n', 'x\na\nb'))).toBe('x\na\nb')
    expect(textEdits('a\nb', 'a\nb\n')).toEqual([{ start: 3, end: 3, text: '\n' }])
  })

  it('never splits a surrogate pair', () => {
    const [edit] = textEdits('x\n\u{1F600}\n', 'x\n\u{1F601}\n')
    expect(edit).toEqual({ start: 2, end: 4, text: '\u{1F601}' })
  })

  it("replaces the changed middle whole past the line diff's work limit", () => {
    const lines = (tag: string) =>
      Array.from({ length: 3000 }, (_, i) => `keep ${i}\n${tag} ${i}\n`).join('')
    const from = `top\n${lines('old')}bottom\n`
    const to = `top\n${lines('new')}bottom\n`
    const edits = textEdits(from, to)
    expect(edits).toHaveLength(1)
    expect(replaceRanges(from, edits)).toBe(to)
  })

  it('turns the first text into the second', () => {
    const text = fc
      .array(fc.constantFrom('a', 'b', '\n', '\u{1F600}', 'cd\n'), { maxLength: 30 })
      .map((parts) => parts.join(''))
    fc.assert(
      fc.property(text, text, (from, to) => {
        const edits = textEdits(from, to)
        expect(replaceRanges(from, edits)).toBe(to)
        const ordered = edits.every(
          (edit, i) => edit.start <= edit.end && (i === 0 || edit.start > edits[i - 1]!.end),
        )
        expect(ordered).toBe(true)
      }),
    )
  })
})
