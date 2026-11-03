import { describe, expect, it } from 'vitest'
import { noteCounts } from '../../../core/noteCounts'
import { noteStats } from './noteStats'

describe("a note's counts", () => {
  it('counts what the Mac counts, leaving out front matter and link Markdown', () => {
    const note = '---\ntitle: a b c\n---\nSee [the docs](https://example.com/x) now'
    expect(noteStats(note)).toEqual({ ...noteCounts(note), readingMinutes: 1 })
    expect(noteStats(note).words).toBe(4)
  })

  it('counts characters without whitespace, and reads at least a minute', () => {
    expect(noteStats('a b\nc')).toEqual({ words: 3, characters: 3, readingMinutes: 1 })
    expect(noteStats('word '.repeat(401)).readingMinutes).toBe(3)
  })
})
