import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appleStrings,
  compileStrings,
  staleOutputs,
  STRINGS_SWIFT,
  XCSTRINGS,
} from '../../scripts/i18n/apple'
import { en } from '../../src/renderer/src/i18n/en'
import { enPhone } from '../../src/renderer/src/i18n/phone'
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

  it('holds no CJK', () => {
    expect(CJK.test(swift)).toBe(false)
    expect(CJK.test(xcstrings)).toBe(false)
  })

  it('are the committed files', async () => {
    const outputs = await appleStrings('.')
    expect(outputs.map(([path]) => path)).toEqual([STRINGS_SWIFT, XCSTRINGS])
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
