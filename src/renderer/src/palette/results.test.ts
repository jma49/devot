import { describe, expect, it } from 'vitest'
import {
  escapeStep,
  lineOfQuery,
  paletteGroups,
  paletteResults,
  ROOT,
  typeInto,
  type PaletteEntry,
  type PaletteKind,
} from './results'

const entries = (kind: PaletteKind, labels: string[]): PaletteEntry[] =>
  labels.map((label, i) => ({ kind, id: `${kind}-${i}`, label }))

const source = {
  command: entries('command', [
    'New Note',
    'Move to Notebook\u2026',
    'Focus Mode',
    'Search All Notes',
  ]),
  book: entries('book', ['Work', 'Weekly Notes', 'Recipes']),
  tag: entries('tag', ['urgent', 'reading', 'work-log']),
  note: entries(
    'note',
    Array.from({ length: 30 }, (_, i) => `Meeting ${i + 1}`),
  ),
  outline: entries('outline', ['Intro', 'Plan', 'Ship it']),
  source: entries('source', ['Commands', 'Notebooks', 'Tags']),
  line: [],
}

const shape = (query: string) =>
  paletteGroups(query, source).map((g) => [g.kind, g.results.map((r) => r.label)])

describe('paletteGroups', () => {
  it('lists every command and the first few of the rest for an empty query', () => {
    const groups = paletteGroups('', source)
    expect(groups.map((g) => g.kind)).toEqual(['command', 'book', 'tag', 'note'])
    expect(groups[0]?.results).toHaveLength(4)
    expect(groups[3]?.results.map((r) => r.label)).toEqual([
      'Meeting 1',
      'Meeting 2',
      'Meeting 3',
      'Meeting 4',
      'Meeting 5',
    ])
  })

  it('keeps the matches of each kind, the group with the best match first', () => {
    expect(shape('work')).toEqual([
      ['book', ['Work']],
      ['tag', ['work-log']],
    ])
    expect(shape('note')).toEqual([
      ['command', ['New Note', 'Search All Notes', 'Move to Notebook\u2026']],
      ['book', ['Weekly Notes']],
    ])
  })

  it('puts a later kind first when its best match beats the earlier kinds', () => {
    const groups = paletteGroups('reading', {
      ...source,
      command: entries('command', ['Reload Editing']),
    })
    expect(groups.map((g) => g.kind)).toEqual(['tag', 'command'])
    expect(groups[0]?.results.map((r) => r.label)).toEqual(['reading'])
  })

  it('caps the results of a kind', () => {
    const notes = paletteGroups('meeting', source).find((g) => g.kind === 'note')
    expect(notes?.results).toHaveLength(20)
  })

  it('marks what matched', () => {
    const [group] = paletteGroups('fm', source)
    expect(group?.results[0]).toMatchObject({
      label: 'Focus Mode',
      ranges: [
        [0, 1],
        [6, 7],
      ],
    })
  })

  it('finds nothing for a query nothing matches', () => {
    expect(paletteGroups('zzz', source)).toEqual([])
  })
})

describe('scoping', () => {
  it('a key and a space scope the palette, and the rest of the text is the query', () => {
    expect(typeInto(ROOT, '> ')).toEqual({ scope: 'command', query: '' })
    expect(typeInto(ROOT, 'b work')).toEqual({ scope: 'book', query: 'work' })
    expect(typeInto(ROOT, 't ')).toEqual({ scope: 'tag', query: '' })
    expect(typeInto(ROOT, '# ')).toEqual({ scope: 'outline', query: '' })
    // The key alone, a longer word and a scoped palette's own text stay queries.
    expect(typeInto(ROOT, 'b')).toEqual({ scope: null, query: 'b' })
    expect(typeInto(ROOT, 'bt x')).toEqual({ scope: null, query: 'bt x' })
    expect(typeInto({ scope: 'book', query: '' }, 't x')).toEqual({ scope: 'book', query: 't x' })
  })

  it('scopes to Go to Line with a colon and a space or a digit', () => {
    expect(typeInto(ROOT, ': ')).toEqual({ scope: 'line', query: '' })
    // A colon alone or before other text stays a search (`:todo:`).
    expect(typeInto(ROOT, ':')).toEqual({ scope: null, query: ':' })
    expect(typeInto(ROOT, ':todo:')).toEqual({ scope: null, query: ':todo:' })
    expect(typeInto(ROOT, ':12')).toEqual({ scope: 'line', query: '12' })
    expect(typeInto(ROOT, ': 12')).toEqual({ scope: 'line', query: '12' })
    expect(typeInto({ scope: 'line', query: '' }, ':3')).toEqual({ scope: 'line', query: ':3' })
  })

  it('reads the line a Go to Line query names, clamped to the note', () => {
    expect(lineOfQuery('12', 40)).toBe(12)
    expect(lineOfQuery(' 7 ', 40)).toBe(7)
    expect(lineOfQuery('999', 40)).toBe(40)
    expect(lineOfQuery('0', 40)).toBeNull()
    expect(lineOfQuery('', 40)).toBeNull()
    expect(lineOfQuery('1.5', 40)).toBeNull()
    expect(lineOfQuery('-3', 40)).toBeNull()
    expect(lineOfQuery('abc', 40)).toBeNull()
    expect(lineOfQuery('3', 0)).toBeNull()
  })

  it('lists the line to go to as it is, unmatched', () => {
    const goTo: PaletteEntry = { kind: 'line', id: 'line:40', label: 'Go to Line 40', line: 40 }
    const groups = paletteResults({ scope: 'line', query: '999' }, { ...source, line: [goTo] })
    expect(groups).toEqual([{ kind: 'line', results: [{ ...goTo, ranges: [] }] }])
    expect(paletteResults({ scope: 'line', query: 'x' }, source)).toEqual([])
  })

  it("lists the sources at the root, and only the scope's results once scoped", () => {
    expect(paletteResults(ROOT, source).map((g) => g.kind)).toEqual(['source'])
    const scoped = paletteResults({ scope: 'book', query: 'work' }, source)
    expect(scoped.map((g) => [g.kind, g.results.map((r) => r.label)])).toEqual([['book', ['Work']]])
    // Text typed at the root still finds every kind.
    expect(paletteResults({ scope: null, query: 'work' }, source).map((g) => g.kind)).toEqual([
      'book',
      'tag',
    ])
  })

  it('keeps an outline in document order until something is typed', () => {
    const all = paletteResults({ scope: 'outline', query: '' }, source)
    expect(all[0]?.results.map((r) => r.label)).toEqual(['Intro', 'Plan', 'Ship it'])
  })

  it('steps back on Escape: the query, the scope, then closes', () => {
    let state = typeInto(ROOT, 't urg')
    expect(state).toEqual({ scope: 'tag', query: 'urg' })
    state = escapeStep(state)!
    expect(state).toEqual({ scope: 'tag', query: '' })
    state = escapeStep(state)!
    expect(state).toEqual(ROOT)
    expect(escapeStep(state)).toBeNull()
    expect(escapeStep({ scope: null, query: 'abc' })).toEqual(ROOT)
  })
})
