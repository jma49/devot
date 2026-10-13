import { describe, expect, it } from 'vitest'
import { paletteGroups, type PaletteEntry, type PaletteKind } from './results'

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
    // The tag is the whole query; the command has its letters only scattered.
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
