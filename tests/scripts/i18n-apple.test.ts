import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_INTENTS_XCSTRINGS,
  WIDGET_XCSTRINGS,
  appleStrings,
  compileSettingsIndex,
  compileStrings,
  SETTINGS_INDEX,
  SHARE_STRINGS_SWIFT,
  SHARE_XCSTRINGS,
  staleOutputs,
  STRINGS_SWIFT,
  XCSTRINGS,
} from '../../scripts/i18n/apple'
import { PANES, PANE_TABS } from '../../src/renderer/src/settings/panes'
import { SETTINGS_ENTRIES } from '../../src/renderer/src/settings/searchEntries'
import { en } from '../../src/renderer/src/i18n/en'
import { enPhone } from '../../src/renderer/src/i18n/phone'
import { zhHans, zhHansPhone } from '../../src/renderer/src/i18n/zh-Hans'
import { CJK } from '../support/policy-patterns'
import { tempDir } from '../support/temp-dirs'

const { swift, xcstrings } = compileStrings(en, enPhone)
const catalog = JSON.parse(xcstrings) as {
  sourceLanguage: string
  strings: Record<string, { localizations: { en: { stringUnit: { value: string } } } }>
}
const english = (key: string) => catalog.strings[key]!.localizations.en.stringUnit.value

describe('the Swift string catalog', () => {
  it('writes every catalog key once, in Strings.swift and in the string catalog', () => {
    const keys = Object.keys(en)
    expect(keys.length).toBeGreaterThan(1000)
    expect(Object.keys(catalog.strings)).toEqual([...keys].sort())
    expect(catalog.sourceLanguage).toBe('en')
    const looked = [...swift.matchAll(/text\("([^"]+)", /g)].map((match) => match[1])
    expect(looked.sort()).toEqual([...keys].sort())
  })

  it('takes the iPhone wording where the iPhone has its own', () => {
    expect(english('editorSettings.detail')).toBe(enPhone['editorSettings.detail'])
    expect(english('phone.tab.notes')).toBe(en['phone.tab.notes'])
  })

  it('turns placeholders into labelled String arguments, in the order they appear', () => {
    const out = compileStrings({ 'a.move': 'Move {title} to {book}', 'a.plain': 'Plain' }, {})
    expect(out.swift).toContain(
      'public static func aMove(title p0: String, book p1: String) -> String {\n' +
        '    fill(text("a.move", "Move {title} to {book}"), ["title": p0, "book": p1])\n' +
        '  }',
    )
    expect(out.swift).toContain(
      'public static func aPlain() -> String {\n    text("a.plain", "Plain")\n  }',
    )
  })

  it('names a key with dashes and underscores in camel case', () => {
    const out = compileStrings({ 'sort.title-asc': 'A', 'status.on_hold': 'B' }, {})
    expect(out.swift).toContain('static func sortTitleAsc()')
    expect(out.swift).toContain('static func statusOnHold()')
  })

  it('takes a repeated placeholder once, and leaves template fields in double braces as text', () => {
    const out = compileStrings({ 'a.b': '{{date}} for {name}, {name}' }, {})
    expect(out.swift).toContain('static func aB(name p0: String) -> String')
  })

  it('escapes a keyword used as a placeholder name', () => {
    const out = compileStrings({ 'a.b': 'In {in}' }, {})
    expect(out.swift).toContain('static func aB(`in` p0: String) -> String')
  })

  it('writes quotes, backslashes and line breaks as Swift escapes', () => {
    const out = compileStrings({ 'a.b': 'Say "hi"\\n\n\tnext' }, {})
    expect(out.swift).toContain('text("a.b", "Say \\"hi\\"\\\\n\\n\\tnext")')
  })

  it('refuses two keys with the same Swift name', () => {
    expect(() => compileStrings({ 'a.b-c': 'x', 'a.bC': 'y' }, {})).toThrow(
      /E_I18N_SWIFT_NAME a.bC/,
    )
  })

  it.each(['Step {1} of {2}', 'At {9am}'])(
    'refuses a placeholder that is no Swift label: %s',
    (text) => {
      expect(() => compileStrings({ 'a.b': text }, {})).toThrow(/E_I18N_PLACEHOLDER_NAME a.b/)
    },
  )

  it('refuses iPhone wording that takes other placeholders than the English', () => {
    expect(() => compileStrings({ 'a.b': 'On {mac}' }, { 'a.b': 'On {phone}' })).toThrow(
      /E_I18N_PLACEHOLDERS a.b/,
    )
  })

  it("gives the Share Extension its own enum with only the share area's keys", async () => {
    const outputs = new Map(await appleStrings('.'))
    const shareSwift = outputs.get(SHARE_STRINGS_SWIFT)!
    const shareCatalog = JSON.parse(outputs.get(SHARE_XCSTRINGS)!) as { strings: object }
    const shareKeys = Object.keys(en).filter((key) => key.startsWith('share.'))
    expect(shareKeys.length).toBeGreaterThan(0)
    expect(Object.keys(shareCatalog.strings)).toEqual([...shareKeys].sort())
    expect(shareSwift).toContain('public enum ShareL10n {')
    expect(shareSwift).toContain('public static func sharePost() -> String {')
  })

  it("gives the app's Shortcuts actions a string catalog with only the intent area's keys", async () => {
    const outputs = new Map(await appleStrings('.'))
    const intents = JSON.parse(outputs.get(APP_INTENTS_XCSTRINGS)!) as { strings: object }
    const intentKeys = Object.keys(en).filter((key) => key.startsWith('intent.'))
    expect(intentKeys).toContain('intent.add.title')
    expect(Object.keys(intents.strings)).toEqual([...intentKeys].sort())
  })

  it("gives the widget and Control a string catalog with only the widget area's keys, translated", async () => {
    const outputs = new Map(await appleStrings('.'))
    const widget = JSON.parse(outputs.get(WIDGET_XCSTRINGS)!) as {
      strings: Record<string, { localizations: object }>
    }
    const widgetKeys = Object.keys(en).filter((key) => key.startsWith('widget.'))
    expect(widgetKeys).toContain('widget.today.title')
    expect(Object.keys(widget.strings)).toEqual([...widgetKeys].sort())
    for (const key of widgetKeys)
      expect({ key, languages: Object.keys(widget.strings[key]!.localizations).sort() }).toEqual({
        key,
        languages: ['en', 'zh-Hans'],
      })
  })

  it('refuses a placeholder in a Shortcuts or widget string, which the system reads by key alone', () => {
    expect(
      Object.entries(en).filter(
        ([key, text]) =>
          (key.startsWith('intent.') || key.startsWith('widget.')) && text.includes('{'),
      ),
    ).toEqual([])
  })

  it('adds each translation beside the English, leaving keys it lacks in English only', () => {
    const out = compileStrings(
      { 'a.move': 'Move {title}', 'a.plain': 'Plain' },
      {},
      { fr: { 'a.move': 'Placer {title}' } },
    )
    const strings = JSON.parse(out.xcstrings).strings
    expect(strings['a.move'].localizations.fr.stringUnit.value).toBe('Placer {title}')
    expect(strings['a.move'].localizations.en.stringUnit.value).toBe('Move {title}')
    expect(strings['a.plain'].localizations.fr).toBeUndefined()
    expect(out.swift).toContain('text("a.move", "Move {title}")')
  })

  it('refuses a translation that takes other placeholders than the English', () => {
    expect(() =>
      compileStrings({ 'a.b': 'On {mac}' }, {}, { fr: { 'a.b': 'Sur {phone}' } }),
    ).toThrow(/E_I18N_PLACEHOLDERS fr a.b/)
  })

  it('writes no CJK into Strings.swift, whose text is the English fallback', async () => {
    const outputs = await appleStrings('.')
    const generated = outputs.find(([path]) => path === STRINGS_SWIFT)![1]
    expect(CJK.test(generated)).toBe(false)
    expect(CJK.test(outputs.find(([path]) => path === SHARE_STRINGS_SWIFT)![1])).toBe(false)
    expect(CJK.test(swift)).toBe(false)
  })

  it('carries the Simplified Chinese catalog, in its iPhone wording', async () => {
    const outputs = await appleStrings('.')
    const strings = JSON.parse(outputs.find(([path]) => path === XCSTRINGS)![1]).strings
    const zh = (key: string) => strings[key].localizations['zh-Hans'].stringUnit.value
    expect(zh('phone.tab.notes')).toBe(zhHans['phone.tab.notes'])
    expect(zh('usage.storage')).toBe(zhHansPhone['usage.storage'])
    expect(Object.keys(strings).every((key) => strings[key].localizations['zh-Hans'])).toBe(true)
  })

  it('are the committed files', async () => {
    const outputs = await appleStrings('.')
    expect(outputs.map(([path]) => path)).toEqual([
      STRINGS_SWIFT,
      XCSTRINGS,
      SETTINGS_INDEX,
      SHARE_STRINGS_SWIFT,
      SHARE_XCSTRINGS,
      APP_INTENTS_XCSTRINGS,
      WIDGET_XCSTRINGS,
    ])
    expect(staleOutputs('.', outputs)).toEqual([])
  })

  it('reports a stale or missing file', () => {
    const root = tempDir('devot-i18n-apple-')
    const outputs = [
      ['Generated/Strings.swift', swift],
      ['Generated/Localizable.xcstrings', xcstrings],
    ] as const
    mkdirSync(dirname(join(root, outputs[0][0])), { recursive: true })
    writeFileSync(join(root, outputs[0][0]), swift)
    expect(staleOutputs(root, outputs)).toEqual(['Generated/Localizable.xcstrings'])
    writeFileSync(join(root, outputs[1][0]), xcstrings)
    expect(staleOutputs(root, outputs)).toEqual([])
    writeFileSync(join(root, outputs[0][0]), swift.replace('Notes', 'Notez'))
    expect(staleOutputs(root, outputs)).toEqual(['Generated/Strings.swift'])
    expect(readFileSync(join(root, outputs[1][0]), 'utf8')).toBe(xcstrings)
  })
})

describe("the native Settings' search index", () => {
  const index = compileSettingsIndex(SETTINGS_ENTRIES, PANES, PANE_TABS)

  it('lists every pane in navigation order with its label key', () => {
    const panes = [...index.matchAll(/^    \("([a-z]+)", "([^"]+)"\),$/gm)]
    expect(panes.map((match) => match[1])).toEqual([...PANES])
    expect(panes.map((match) => match[2])).toEqual(PANES.map((pane) => PANE_TABS[pane].label))
  })

  it('lists every entry in order, with the device that alone shows it', () => {
    const entries = [
      ...index.matchAll(
        /^    Entry\(pane: "([a-z]+)", label: "([^"]+)", only: (\.mac|\.phone|nil)\),$/gm,
      ),
    ]
    expect(entries.map((match) => [match[1], match[2], match[3]])).toEqual(
      SETTINGS_ENTRIES.map((entry) => [
        entry.pane,
        entry.label,
        entry.only ? `.${entry.only}` : 'nil',
      ]),
    )
  })

  it('names only keys the string catalog has', () => {
    for (const [, key] of index.matchAll(/"([a-zA-Z]+\.[a-zA-Z.]+)"/g))
      expect(en).toHaveProperty([key!])
  })
})
