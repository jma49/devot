import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CountsFooter, countsStore, countText, wordsText } from './CountsFooter'

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

  it('shows the words toward the note\u2019s goal, and the selection\u2019s part while one is selected', () => {
    expect(wordsText({ words: 340, characters: 0, selection: null, goal: 1500 }, 'en')).toBe(
      '340 / 1,500',
    )
    expect(
      wordsText(
        { words: 340, characters: 0, selection: { words: 12, characters: 50 }, goal: 1500 },
        'en',
      ),
    ).toBe('12 of 340')
    expect(wordsText({ words: 340, characters: 0, selection: null }, 'en')).toBe('340')
    const html = renderToStaticMarkup(
      <CountsFooter counts={{ words: 1600, characters: 9000, selection: null, goal: 1500 }} />,
    )
    expect(html).toContain('title="Word goal: 1,500"')
    expect(html).toContain('Words 1,600 / 1,500')
  })

  it('keeps its line before the first count, so the panes do not move when it arrives', () => {
    expect(renderToStaticMarkup(<CountsFooter counts={null} />)).toBe(
      '<p class="editor-counts"></p>',
    )
  })
})

describe('the counts store', () => {
  it('holds the latest count and tells its subscribers, until they leave', () => {
    const store = countsStore()
    const seen: number[] = []
    const leave = store.subscribe(() => seen.push(store.get()!.words))
    expect(store.get()).toBeNull()
    store.set({ words: 1, characters: 3, selection: null })
    leave()
    store.set({ words: 2, characters: 6, selection: null })
    expect(seen).toEqual([1])
    expect(store.get()?.words).toBe(2)
  })
})
