import { describe, expect, it } from 'vitest'
import { currentHeading, outlineHeadings, shownAncestor, shownHeadings } from './headings'

const NOTE = [
  '# One', //1
  'text', //2
  '## Alpha', //3
  '### Deep', //4
  '## Beta', //5
  '- [ ] a task, not a heading', //6
  '# Two', //7
  '```', //8
  '# not a heading', //9
  '```', //10
  '### Skips a level', //11
].join('\n')

describe('the outline headings', () => {
  it('lists headings only, nested by level', () => {
    const headings = outlineHeadings(NOTE)
    expect(headings.map((h) => [h.label, h.line, h.parent, h.hasChildren])).toEqual([
      ['One', 1, -1, true],
      ['Alpha', 3, 0, true],
      ['Deep', 4, 1, false],
      ['Beta', 5, 0, false],
      ['Two', 7, -1, true],
      ['Skips a level', 11, 4, false],
    ])
  })

  it('skips front matter', () => {
    expect(outlineHeadings('---\n# not: a heading\n---\n# Real').map((h) => h.label)).toEqual([
      'Real',
    ])
  })

  it('keeps a heading’s key when lines come and go above it', () => {
    const before = outlineHeadings('# A\n## Same\n## Same\n')
    const after = outlineHeadings('new\n\n# A\n## Same\n## Same\n')
    expect(after.map((h) => h.key)).toEqual(before.map((h) => h.key))
    expect(new Set(before.map((h) => h.key)).size).toBe(3)
  })
})

describe('the current heading', () => {
  const headings = outlineHeadings(NOTE)

  it('is the last heading at or above the line', () => {
    expect(currentHeading(headings, 1)).toBe(0)
    expect(currentHeading(headings, 2)).toBe(0)
    expect(currentHeading(headings, 4)).toBe(2)
    expect(currentHeading(headings, 6)).toBe(3)
    expect(currentHeading(headings, 10)).toBe(4)
    expect(currentHeading(headings, 999)).toBe(5)
  })

  it('is none above the first heading, and in a note without headings', () => {
    expect(currentHeading(outlineHeadings('text\n# H'), 1)).toBe(-1)
    expect(currentHeading([], 5)).toBe(-1)
  })
})

describe('folding', () => {
  const headings = outlineHeadings(NOTE)

  it('hides what is under a folded heading, at any depth', () => {
    expect(shownHeadings(headings, new Set())).toEqual([0, 1, 2, 3, 4, 5])
    expect(shownHeadings(headings, new Set([headings[0]!.key]))).toEqual([0, 4, 5])
    expect(shownHeadings(headings, new Set([headings[1]!.key]))).toEqual([0, 1, 3, 4, 5])
  })

  it('stands in the nearest shown ancestor for a heading folded away', () => {
    const shown = shownHeadings(headings, new Set([headings[0]!.key]))
    expect(shownAncestor(headings, shown, 2)).toBe(0)
    expect(shownAncestor(headings, shown, 5)).toBe(5)
  })
})
