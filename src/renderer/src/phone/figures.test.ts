import { describe, expect, it } from 'vitest'
import { figureParts } from './figures'

describe('a message with figures in it', () => {
  it('marks each filled placeholder as a figure and leaves the words as text', () => {
    expect(figureParts('{current} of {total}', { current: '2', total: '14' })).toEqual([
      { text: '2', figure: true },
      { text: ' of ', figure: false },
      { text: '14', figure: true },
    ])
  })

  it('keeps words around a lone value', () => {
    expect(figureParts('Added {date}', { date: 'Nov 14, 2023' })).toEqual([
      { text: 'Added ', figure: false },
      { text: 'Nov 14, 2023', figure: true },
    ])
  })

  it('leaves a placeholder with no value as it is', () => {
    expect(figureParts('{a} and {b}', { a: '1' })).toEqual([
      { text: '1', figure: true },
      { text: ' and {b}', figure: false },
    ])
  })
})
