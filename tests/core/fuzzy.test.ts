import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyRank } from '../../src/core/fuzzy'

const marked = (text: string, query: string) =>
  fuzzyMatch(query, text)?.ranges.map(([from, to]) => text.slice(from, to))

describe('fuzzyMatch', () => {
  it('matches the query letters in order, case and accents aside', () => {
    expect(marked('Move to Notebook', 'mnb')).toEqual(['M', 'N', 'b'])
    expect(marked('Caf\u00e9 notes', 'cafe')).toEqual(['Caf\u00e9'])
    expect(marked('cafe', 'CAF\u00c9')).toEqual(['cafe'])
    expect(fuzzyMatch('xyz', 'Move to Notebook')).toBeNull()
    expect(fuzzyMatch('bm', 'Move to Notebook')).toBeNull()
  })

  it('ignores spaces in the query and matches across words', () => {
    expect(marked('Move to Notebook', 'move note')).toEqual(['Move', 'Note'])
  })

  it('prefers word starts and runs of letters', () => {
    // "nb" at the starts of "New" and "Book" beats the n and b inside "unbox".
    const words = fuzzyMatch('nb', 'New Book')!
    const inside = fuzzyMatch('nb', 'unbox')!
    expect(words.score).toBeGreaterThan(inside.score)
    expect(fuzzyMatch('dup', 'Duplicate')!.score).toBeGreaterThan(fuzzyMatch('dup', 'Do Up')!.score)
    expect(marked('Search in Current View', 'cv')).toEqual(['C', 'V'])
  })

  it('handles characters outside the Basic Multilingual Plane and CJK text', () => {
    const text = '\ud83c\udf89 \u5468\u62a5 notes'
    expect(marked(text, '\u5468\u62a5')).toEqual(['\u5468\u62a5'])
    expect(marked(text, 'notes')).toEqual(['notes'])
  })

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('  ', 'Anything')).toEqual({ score: 0, ranges: [] })
  })

  it('stays fast and finite on long text', () => {
    const long = `${'a'.repeat(5000)}z`
    expect(fuzzyMatch('z', long)).toBeNull()
    expect(fuzzyMatch('aaa', long)?.ranges).toEqual([[0, 3]])
  })
})

describe('fuzzyRank', () => {
  const items = ['Unpin', 'Pin to Top', 'Print', 'Preview Mode', 'Open Spinner']
  it('keeps the matches, best first, shorter text first on a tie', () => {
    const ranked = fuzzyRank('pin', items, (s) => s)
    expect(ranked.map((r) => r.item)).toEqual(['Pin to Top', 'Unpin', 'Print', 'Open Spinner'])
    expect(ranked[0]?.ranges).toEqual([[0, 3]])
  })

  it('keeps the given order for an empty query', () => {
    expect(fuzzyRank('', items, (s) => s).map((r) => r.item)).toEqual(items)
  })
})
