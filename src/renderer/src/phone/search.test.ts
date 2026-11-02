import { describe, expect, it } from 'vitest'
import { searchPattern } from '../../../core/search'
import { wellFormed } from '../../../core/text'
import {
  excerptNearMatch,
  MAX_RECENT_SEARCHES,
  readRecentSearches,
  RECENT_SEARCHES_KEY,
  rememberSearch,
} from './search'

const store = (initial?: string) => {
  const items = new Map<string, string>(initial ? [[RECENT_SEARCHES_KEY, initial]] : [])
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  }
}

describe('recent searches', () => {
  it('keeps the newest first, once each, and only so many', () => {
    const s = store()
    for (const q of ['a', 'b', 'a']) rememberSearch(s, q)
    expect(readRecentSearches(s)).toEqual(['a', 'b'])
    for (let i = 0; i < 20; i += 1) rememberSearch(s, `q${i}`)
    expect(readRecentSearches(s)).toHaveLength(MAX_RECENT_SEARCHES)
    expect(readRecentSearches(s)[0]).toBe('q19')
  })

  it('ignores a blank query and trims the rest', () => {
    const s = store()
    expect(rememberSearch(s, '   ')).toEqual([])
    expect(rememberSearch(s, '  relay ')).toEqual(['relay'])
  })

  it('reads anything unexpected as no searches', () => {
    expect(readRecentSearches(store('{broken'))).toEqual([])
    expect(readRecentSearches(store('{"a":1}'))).toEqual([])
    expect(readRecentSearches(store('["a",1,""]'))).toEqual(['a'])
    expect(readRecentSearches(undefined)).toEqual([])
  })

  it('survives a store that refuses writes', () => {
    const s = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full')
      },
    }
    expect(rememberSearch(s, 'relay')).toEqual(['relay'])
  })
})

describe('excerptNearMatch', () => {
  const near = (text: string, term: string) => excerptNearMatch(text, searchPattern([term]))

  it('leaves an excerpt whose match is already near its start', () => {
    expect(near('the relay sleeps', 'relay')).toBe('the relay sleeps')
    expect(near('…the relay sleeps', 'relay')).toBe('…the relay sleeps')
  })

  it('starts at a word shortly before the match, with an ellipsis', () => {
    const text = 'a long opening sentence goes on and then the relay sleeps'
    expect(near(text, 'relay')).toBe('…then the relay sleeps')
    expect(near(`…${text}`, 'RELAY')).toBe('…then the relay sleeps')
  })

  it('cuts text without spaces in place, never inside a surrogate pair', () => {
    const text = `${'\u{1f600}'.repeat(20)}relay`
    const cut = near(text, 'relay')
    expect(cut.endsWith('relay')).toBe(true)
    expect(cut).toBe(wellFormed(cut))
  })

  it('leaves text with no match', () => {
    expect(near('nothing here', 'relay')).toBe('nothing here')
    expect(excerptNearMatch('nothing here', null)).toBe('nothing here')
  })
})
