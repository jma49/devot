import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const SPEC = 'docs/specs/iphone-screens.md'
const ADR = 'docs/adr/0018-iphone-native-shell-around-a-web-editor.md'
const SUPERSEDED = 'docs/adr/0010-phone-glass-drawn-in-css.md'

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

// Tables, code and a bold lead-in keep their own punctuation; only running prose is checked.
function proseLines(text: string): string[] {
  return text
    .replace(/^```[\s\S]*?^```/gm, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('|'))
    .map((line) =>
      line
        .replace(/(`+)[\s\S]*?\1/g, 'code')
        .replace(/^\s*(?:[-*]|\d+\.)\s+/, '')
        .replace(/^\*\*[^*]+\*\*\s*/, ''),
    )
}

const SENTENCE_BREAK = /[\w)\]"'][.!?]["')]?\s+[A-Z]/

function linesWithTwoSentences(file: string): string[] {
  return proseLines(read(file)).filter((line) => SENTENCE_BREAK.test(line))
}

it.each([SPEC, ADR])('%s is written one sentence per line', (file) => {
  expect(read(file)).not.toBe('')
  expect(linesWithTwoSentences(file)).toEqual([])
})

it('finds a line that holds two sentences', () => {
  expect(proseLines('One sentence. Another one.\n')).toHaveLength(2)
  expect(SENTENCE_BREAK.test('One sentence. Another one.')).toBe(true)
  expect(SENTENCE_BREAK.test('A value of 0.25 stays one sentence.')).toBe(false)
})

it('the native shell ADR supersedes the CSS glass ADR, and the old one says so', () => {
  expect(read(ADR)).toMatch(/^Status: accepted\b.*supersedes ADR 0010/im)
  expect(read(SUPERSEDED)).toMatch(/^Status: .*superseded by ADR 0018/im)
})

it.each([
  'Message envelope',
  'Operations',
  'Editor screen protocol',
  'Glass map',
  'Settings tree',
  'Spikes',
])('the iPhone screens spec has a %s section', (heading) => {
  expect(read(SPEC)).toMatch(new RegExp(`^## ${heading}$`, 'm'))
})

it.each(['Screens', 'WebStage', 'EditorScreen', 'Rust-direct read', 'The gate'])(
  'the glossary defines %s',
  (term) => {
    expect(read('GLOSSARY.md')).toContain(`- **${term}:**`)
  },
)
