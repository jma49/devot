import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../tests/support/budget'
import { noteCounts } from './noteCounts'

describe('noteCounts', () => {
  it('counts words and characters without whitespace', () => {
    expect(noteCounts('a b\nc')).toEqual({ words: 3, characters: 3 })
    expect(noteCounts('')).toEqual({ words: 0, characters: 0 })
  })

  it('leaves out front matter', () => {
    expect(noteCounts('---\ntitle: one two three\ntags: [a]\n---\nbody text')).toEqual({
      words: 2,
      characters: 8,
    })
  })

  it('counts the label of a link and the alt text of an image, not their Markdown', () => {
    expect(noteCounts('See [the docs](https://example.com/some/long/path) now')).toEqual({
      words: 4,
      characters: 13,
    })
    expect(noteCounts('![a cat](cat.png)')).toEqual({ words: 2, characters: 4 })
    expect(noteCounts('[ref][1] x\n\n[1]: http://example.com "title"').words).toBe(2)
  })

  it('counts each CJK character as a word', () => {
    expect(noteCounts('\u540c\u6b65 sync \u3042\ud55c')).toEqual({ words: 5, characters: 8 })
  })

  it('leaves out bare Markdown marks', () => {
    expect(noteCounts('## Pairing\n\n- [ ] Ask the relay')).toMatchObject({ words: 4 })
    expect(noteCounts('**bold** and `code`')).toEqual({ words: 3, characters: 11 })
  })

  it('counts a long note within a budget', (context) => {
    const note = `# Title\n\n${'Some *words* in a [link](https://example.com/page) here.\n\n'.repeat(5000)}`
    const start = performance.now()
    const counts = noteCounts(note)
    expectWithinBudget(context, performance.now() - start, 500)
    expect(counts.words).toBe(5000 * 6 + 1)
  })
})
