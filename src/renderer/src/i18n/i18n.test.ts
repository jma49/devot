import { describe, expect, it } from 'vitest'
import { format, resolveLocale, setLocale, t } from '.'
import { en } from './en'

describe('i18n', () => {
  it('falls back to English for unsupported languages', () => {
    expect(resolveLocale(['fr-FR', 'de'])).toBe('en')
    expect(resolveLocale([])).toBe('en')
  })

  it('matches a supported base language from a regional tag', () => {
    expect(resolveLocale(['en-GB'])).toBe('en')
  })

  it('returns English strings by key, even for an unknown locale', () => {
    setLocale('xx')
    expect(t('noteList.newNote')).toBe('New Note')
    setLocale('en')
    expect(t('note.untitled')).toBe('Untitled')
  })

  it('fills placeholders with values taken as plain text', () => {
    expect(format('{filter} in {book}', { filter: 'Sync', book: 'Work' })).toBe('Sync in Work')
    // Replacement patterns and placeholders inside a value stay as typed.
    expect(format('In {view}', { view: "Make $$ $& $` $'" })).toBe("In Make $$ $& $` $'")
    expect(format('{filter} in {book}', { filter: '{book}', book: 'Work' })).toBe('{book} in Work')
    // A placeholder with no value is left as it is.
    expect(format('{a} and {b}', { a: '1' })).toBe('1 and {b}')
  })

  it('spells each word one way, British, across the catalog', () => {
    const american =
      /\b(?:cent(?:er|ers|ered|ering)|color\w*|gray|(?:organ|categor|custom|normal|summar|synchron|visual|minim|maxim|util|real|recogn|initial)iz\w*)\b/i
    const found = Object.entries(en).filter(([, text]) => american.test(text))
    expect(found).toEqual([])
  })
})
