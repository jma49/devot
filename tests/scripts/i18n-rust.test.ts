import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  compileNative,
  fieldName,
  NATIVE_RS,
  nativeStrings,
  rustString,
} from '../../scripts/i18n/rust'
import { appleStrings, XCSTRINGS } from '../../scripts/i18n/apple'
import { messages as english } from '../../src/renderer/src/i18n/en/native'
import { messages as simplified } from '../../src/renderer/src/i18n/zh-Hans/native'
import { CJK } from '../support/policy-patterns'

const root = join(import.meta.dirname, '../..')

describe("the Mac's native text for Rust", () => {
  it('names each field in snake case, a digit after its word', () => {
    expect(fieldName('native.menuFile')).toBe('menu_file')
    expect(fieldName('native.formatHeading1')).toBe('format_heading_1')
    expect(fieldName('native.exportAllHtml')).toBe('export_all_html')
    expect(() => fieldName('menu.file')).toThrow('E_I18N_RUST_KEY')
    expect(() => fieldName('clipper.appName')).toThrow('E_I18N_RUST_KEY')
  })

  it('escapes every character outside printable ASCII, so the file holds no CJK', () => {
    expect(rustString('Open Today\u2019s Note')).toBe('"Open Today\\u{2019}s Note"')
    expect(rustString('\u6587\u4ef6')).toBe('"\\u{6587}\\u{4ef6}"')
    expect(rustString('say "hi"\\\n')).toBe('"say \\"hi\\"\\\\\\n"')
    expect(readFileSync(join(root, NATIVE_RS), 'utf8')).not.toMatch(CJK)
  })

  it('writes one static per language, English where a translation is missing', () => {
    const rust = compileNative(
      { 'native.a': 'A', 'native.b': 'B' },
      { ZH_HANS: { 'native.a': 'X' } },
    )
    expect(rust).toContain(
      "pub struct Native {\n    pub a: &'static str,\n    pub b: &'static str,\n}",
    )
    expect(rust).toContain('pub static EN: Native = Native {\n    a: "A",\n    b: "B",\n};')
    expect(rust).toContain('pub static ZH_HANS: Native = Native {\n    a: "X",\n    b: "B",\n};')
  })

  it('refuses a translation whose placeholders differ from the English', () => {
    expect(() =>
      compileNative({ 'native.a': 'Folder: {folder}' }, { ZH_HANS: { 'native.a': 'Folder' } }),
    ).toThrow('E_I18N_PLACEHOLDERS ZH_HANS native.a')
  })

  it('refuses two keys with the same field name', () => {
    expect(() => compileNative({ 'native.aB': 'A', 'native.a_b': 'B' }, {})).toThrow('E_I18N_RUST')
  })

  it('is up to date with the catalog, and translates every key', async () => {
    expect(await nativeStrings(root)).toBe(readFileSync(join(root, NATIVE_RS), 'utf8'))
    const untranslated = Object.keys(english).filter(
      (key) => simplified[key as keyof typeof english] === english[key as keyof typeof english],
    )
    expect(untranslated).toEqual([
      'native.exportMarkdownFilter',
      'native.exportHtmlFilter',
      'native.exportPdfFilter',
    ])
  })

  it("leaves the native area out of the iPhone's strings, which show none of it", async () => {
    const outputs = new Map(await appleStrings(root))
    const keys = Object.keys(JSON.parse(outputs.get(XCSTRINGS)!).strings)
    expect(keys.some((key) => key.startsWith('native.'))).toBe(false)
  })
})
