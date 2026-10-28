// `devot --notebook <name>` finds the notebook it names. Names come from the shell, which may hand
// over a decomposed (NFD) spelling of what storage holds composed (NFC), as macOS does for a name
// typed with accents (A142, A180).
import { describe, expect, it } from 'vitest'
import { openDestination } from '../../src/renderer/src/cliOpen'

const BOOKS = [
  { id: 'b1', name: 'Café' },
  { id: 'b2', name: 'Work' },
]

describe('openDestination', () => {
  it('finds a composed name from a decomposed one, and the other way round', () => {
    const nfd = 'Cafe\u0301'
    expect(nfd).not.toBe('Café')
    expect(openDestination(nfd, BOOKS, null)).toEqual({ kind: 'book', id: 'b1' })
    expect(openDestination('Café', [{ id: 'b1', name: nfd }], null)).toEqual({
      kind: 'book',
      id: 'b1',
    })
  })

  it('still prefers an exact name, then one differing only in case', () => {
    const books = [
      { id: 'lower', name: 'work' },
      { id: 'exact', name: 'Work' },
    ]
    expect(openDestination('Work', books, null)).toEqual({ kind: 'book', id: 'exact' })
    expect(openDestination('WORK', books, null)).toEqual({ kind: 'book', id: 'lower' })
  })

  it('makes a notebook when none matches', () => {
    expect(openDestination('Cafeteria', BOOKS, null)).toEqual({
      kind: 'create',
      name: 'Cafeteria',
    })
  })
})
