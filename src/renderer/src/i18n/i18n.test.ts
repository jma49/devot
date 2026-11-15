import { afterEach, describe, expect, it, vi } from 'vitest'
import { format, resolveLocale, setIPhoneWording, setLocale, setPhoneDevice, t } from '.'
import { en } from './en'
import { enPhone } from './phone'
import { zhHans, zhHansPhone } from './zh-Hans'

describe('i18n', () => {
  it('falls back to English for unsupported languages', () => {
    expect(resolveLocale(['fr-FR', 'de'])).toBe('en')
    expect(resolveLocale([])).toBe('en')
  })

  it('matches a supported base language from a regional tag', () => {
    expect(resolveLocale(['en-GB'])).toBe('en')
  })

  it('picks Simplified Chinese for a Chinese tag that is not Traditional', () => {
    expect(resolveLocale(['zh-Hans-CN'])).toBe('zh-hans')
    expect(resolveLocale(['zh-CN'])).toBe('zh-hans')
    expect(resolveLocale(['zh-SG'])).toBe('zh-hans')
    expect(resolveLocale(['zh'])).toBe('zh-hans')
    expect(resolveLocale(['fr', 'zh-Hans'])).toBe('zh-hans')
  })

  it('passes over Traditional Chinese to the next language preferred', () => {
    expect(resolveLocale(['zh-Hant-TW', 'zh-Hans'])).toBe('zh-hans')
    expect(resolveLocale(['zh-TW'])).toBe('en')
    expect(resolveLocale(['zh-HK', 'en-GB'])).toBe('en')
    expect(resolveLocale(['zh-Hant'])).toBe('en')
    expect(resolveLocale(['zh-MO'])).toBe('en')
  })

  it('returns the Simplified Chinese text, and its iPhone wording', async () => {
    await setLocale('zh-hans')
    expect(t('noteList.newNote')).toBe(zhHans['noteList.newNote'])
    setIPhoneWording(true)
    expect(t('usage.storage')).toBe(zhHansPhone['usage.storage'])
    expect(t('noteList.newNote')).toBe(zhHans['noteList.newNote'])
    setIPhoneWording(false)
    expect(t('usage.storage')).toBe(zhHans['usage.storage'])
    await setLocale('en')
  })

  describe('the page', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('says which language its text is in, so the system picks its glyphs and its voice', async () => {
      const page = { documentElement: { lang: 'en' } }
      vi.stubGlobal('document', page)
      await setLocale('zh-hans')
      expect(page.documentElement.lang).toBe('zh-Hans')
      await setLocale('xx')
      expect(page.documentElement.lang).toBe('en')
      await setLocale('zh-hans')
      await setLocale('en')
      expect(page.documentElement.lang).toBe('en')
    })
  })

  it('returns English strings by key, even for an unknown locale', async () => {
    await setLocale('xx')
    expect(t('noteList.newNote')).toBe('New Note')
    await setLocale('en')
    expect(t('note.untitled')).toBe('Untitled')
  })

  it('names the iPad instead of the iPhone on an iPad, in every language', async () => {
    setIPhoneWording(true)
    setPhoneDevice('iPad')
    expect(t('usage.storage')).toBe('Stored on this iPad')
    expect(t('phone.sync.notesStay')).toBe('Notes stay on this iPad')
    await setLocale('zh-hans')
    expect(t('usage.storage')).toBe(zhHansPhone['usage.storage']!.replaceAll('iPhone', 'iPad'))
    expect(t('usage.storage')).not.toContain('iPhone')
    await setLocale('en')
    setPhoneDevice('iPhone')
    expect(t('usage.storage')).toBe('Stored on this iPhone')
    setIPhoneWording(false)
  })

  it('words messages that name the Mac for the iPhone layout, and back', () => {
    setIPhoneWording(true)
    expect(t('usage.storage')).toBe('Stored on this iPhone')
    expect(t('noteList.newNote')).toBe('New Note')
    setIPhoneWording(false)
    expect(t('usage.storage')).toBe('Stored on this Mac')
  })

  it('has an iPhone wording only for messages that exist, and none names the Mac', () => {
    const entries = Object.entries(enPhone)
    expect(entries.filter(([key]) => !(key in en))).toEqual([])
    expect(
      entries.filter(([, text]) => /\bMac\b|macOS|System Settings|desktop/.test(text)),
    ).toEqual([])
  })

  it('fills placeholders with values taken as plain text', () => {
    expect(format('{filter} in {book}', { filter: 'Sync', book: 'Work' })).toBe('Sync in Work')
    // Replacement patterns and placeholders inside a value stay as typed.
    expect(format('In {view}', { view: "Make $$ $& $` $'" })).toBe("In Make $$ $& $` $'")
    expect(format('{filter} in {book}', { filter: '{book}', book: 'Work' })).toBe('{book} in Work')
    // A placeholder with no value is left as it is.
    expect(format('{a} and {b}', { a: '1' })).toBe('1 and {b}')
  })

  it('spells each word one way, American, across the catalog', () => {
    const british =
      /\b(?:centre\w*|colour\w*|grey\w*|behaviour\w*|favourite\w*|licence\w*|cancell(?:ed|ing)|(?:organ|categor|custom|normal|summar|synchron|visual|minim|maxim|util|real|recogn|initial)is(?:e|es|ed|ing|ation\w*))\b/i
    const found = Object.entries(en).filter(([, text]) => british.test(text))
    expect(found).toEqual([])
  })
})
