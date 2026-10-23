import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitIn, listFiles } from '../support/git-files'
import { CJK, hasCjk } from '../support/policy-patterns'
import { tempDir } from '../support/temp-dirs'

// English-only codebase: UI text lives in locale catalogs, CJK test data uses \u escapes.
const BINARY = /\.(png|webp|icns|ico|sqlite|woff2?)$/

it('no tracked file contains CJK characters', () => {
  const files = listFiles('.').filter((f) => !BINARY.test(f))
  const offenders = files.flatMap((file) => {
    const named = hasCjk(file) ? [`${file} (name)`] : []
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return named
    }
    return [
      ...named,
      ...text.split('\n').flatMap((line, i) => (CJK.test(line) ? [`${file}:${i + 1}`] : [])),
    ]
  })
  expect(offenders).toEqual([])
})

it('the file listing returns a non-ASCII file name as written, not quoted', () => {
  const repo = tempDir('devot-cjk-names-')
  gitIn(repo, 'init', '-q')
  // Built from code points so this file holds no CJK itself.
  const name = `${String.fromCodePoint(0x4e2d)}.txt`
  writeFileSync(join(repo, name), 'x')
  const files = listFiles(repo)
  expect(files).toEqual([name])
  expect(files.some(hasCjk)).toBe(true)
})

// Sample characters by code point, so this file holds no CJK itself.
const SAMPLES: Record<string, number> = {
  'a Han ideograph': 0x4e2d,
  'a Han ideograph of extension A': 0x3400,
  'a Han ideograph of extension B (supplementary plane)': 0x20000,
  'a compatibility ideograph': 0xf900,
  'a compatibility ideograph of the supplement (supplementary plane)': 0x2f800,
  'a Hiragana letter': 0x3042,
  'a Katakana letter': 0x30a2,
  'a halfwidth Katakana letter': 0xff76,
  'the prolonged sound mark': 0x30fc,
  'a Hangul syllable': 0xac00,
  'a Hangul jamo': 0x1100,
  'a Hangul compatibility jamo': 0x3131,
  'a Bopomofo letter': 0x3105,
  'an ideographic comma': 0x3001,
  'an ideographic space': 0x3000,
  'a fullwidth letter': 0xff21,
  'an enclosed ideograph': 0x3220,
  'a CJK stroke': 0x31c0,
}

for (const [name, code] of Object.entries(SAMPLES)) {
  it(`the CJK pattern catches ${name}`, () => {
    expect(hasCjk(`before ${String.fromCodePoint(code)} after`)).toBe(true)
  })
}

it('the CJK pattern leaves English text, accents, other scripts, emoji and \\u escapes alone', () => {
  const backslash = String.fromCharCode(92)
  for (const text of [
    'plain English text',
    'café naïve',
    String.fromCodePoint(0xb7, 0x2c7, 0x2014, 0x2192, 0x2500, 0xd7),
    'Жук Ωμέγα שלום',
    String.fromCodePoint(0x1f600),
    `${backslash}u3042 ${backslash}u{20000} ${backslash}uac00`,
  ]) {
    expect(hasCjk(text)).toBe(false)
  }
})
