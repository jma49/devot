import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CountsFooter, countText } from './CountsFooter'

describe('the editor footer counts', () => {
  it('shows the note, with the selection as a part of it', () => {
    expect(countText(1234, undefined, 'en')).toBe('1,234')
    expect(countText(1234, 12, 'en')).toBe('12 of 1,234')
  })

  it('names words and characters', () => {
    const html = renderToStaticMarkup(
      <CountsFooter
        counts={{ words: 3, characters: 11, selection: { words: 2, characters: 6 } }}
      />,
    )
    expect(html).toContain('Words 2 of 3')
    expect(html).toContain('Characters 6 of 11')
  })

  it('is empty before the first count', () => {
    expect(renderToStaticMarkup(<CountsFooter counts={null} />)).toBe('')
  })
})
