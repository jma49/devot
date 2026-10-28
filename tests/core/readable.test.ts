import fc from 'fast-check'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../support/budget'
import {
  bodyExcerpt,
  EXCERPT_BEFORE,
  EXCERPT_CHARS,
  matchSegments,
  readableText,
  searchPattern,
} from '../../src/core'

// Excerpts show readable text; the shared cases hold the Rust store
// (src-tauri/src/storage/readable.rs) to the same rules.

interface Case {
  name: string
  markdown: string
  text: string
}
const CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, '../support/readable-text.json'), 'utf8'),
) as Case[]

// Chinese words, built from code points: "meeting", "sync", "plan".
const MEETING = String.fromCodePoint(0x4f1a, 0x8bae)
const SYNC = String.fromCodePoint(0x540c, 0x6b65)
const PLAN = String.fromCodePoint(0x8ba1, 0x5212)
const ELLIPSIS = String.fromCodePoint(0x2026)

const marked = (excerpt: string | undefined, term: string) =>
  matchSegments(excerpt ?? '', searchPattern([term]))
    .filter((s) => s.match)
    .map((s) => s.text)

describe('readableText', () => {
  it.each(CASES)('$name', ({ markdown, text }) => {
    expect(readableText(markdown)).toBe(text)
  })
})

describe('bodyExcerpt', () => {
  it('skips front matter and Markdown markers, and the words found stay marked', () => {
    const body = [
      '---',
      'title: Launch plan',
      'tags: [work, q4]',
      'status: on hold',
      '---',
      '![Board](board.png)',
      '# Inbox',
      'See [[Plan]] and the **launch** checklist',
    ].join('\n')
    const excerpt = bodyExcerpt(body, ['LAUNCH'])
    expect(excerpt).toBe('Board Inbox See Plan and the launch checklist')
    expect(matchSegments(excerpt ?? '', searchPattern(['LAUNCH']))).toEqual([
      { text: 'Board Inbox See Plan and the ', match: false },
      { text: 'launch', match: true },
      { text: ' checklist', match: false },
    ])
  })

  it('finds no excerpt for a word only front matter or syntax holds', () => {
    expect(bodyExcerpt('---\ntitle: secret\n---\nBody', ['secret'])).toBeUndefined()
    expect(bodyExcerpt('See [docs](https://hidden.example)', ['hidden'])).toBeUndefined()
    expect(bodyExcerpt('Plain **bold**', ['**bold'])).toBeUndefined()
  })

  it('cuts its window from the readable text', () => {
    const body = `---\n${'key: value\n'.repeat(30)}---\n# Notes\n${'**word** '.repeat(20)}the needle [here](x)`
    const text = readableText(body)
    const at = [...text].indexOf('n', [...text].length - 'needle here'.length)
    const excerpt = bodyExcerpt(body, ['needle'])
    expect(excerpt).toBe(
      `${ELLIPSIS}${[...text].slice(at - EXCERPT_BEFORE, at - EXCERPT_BEFORE + EXCERPT_CHARS).join('')}`,
    )
    expect(excerpt).not.toMatch(/key|\*|\[|#/)
    expect(marked(excerpt, 'needle')).toEqual(['needle'])
  })

  it('cleans Chinese text, and marks the Chinese word found', () => {
    const body = `# ${MEETING}\n- ${SYNC} **${PLAN}**`
    const excerpt = bodyExcerpt(body, [PLAN])
    expect(excerpt).toBe(`${MEETING} ${SYNC} ${PLAN}`)
    expect(marked(excerpt, PLAN)).toEqual([PLAN])
  })
})

// Plain words: letters, digits, Chinese and a character outside the BMP.
const word = fc
  .array(
    fc.constantFrom('a', 'Z', 'q', '7', MEETING[0]!, SYNC[1]!, PLAN, String.fromCodePoint(0x1f680)),
    { minLength: 1, maxLength: 6 },
  )
  .map((chars) => chars.join(''))

const INLINE: ((w: string) => string)[] = [
  (w) => `*${w}*`,
  (w) => `**${w}**`,
  (w) => `_${w}_`,
  (w) => `__${w}__`,
  (w) => `~~${w}~~`,
  (w) => `[${w}](https://devot.app/a_(b))`,
  (w) => `![${w}](image.png "Title")`,
  (w) => `[${w}][ref]`,
  (w) => `<span class="x">${w}</span>`,
]
const EMPHASIS = ['*', '*', '_', '_', '~']
// Double-bracket links hold plain text only, so they go around a word.
const AROUND_WORD: ((w: string) => string)[] = [
  (w) => w,
  (w) => `[[${w}]]`,
  (w) => `[[Target|${w}]]`,
]
const BLOCK: ((line: string) => string)[] = [
  (l) => l,
  (l) => `# ${l}`,
  (l) => `### ${l} ###`,
  (l) => `> ${l}`,
  (l) => `> > ${l}`,
  (l) => `- ${l}`,
  (l) => `12. ${l}`,
  (l) => `- [x] ${l}`,
  (l) => `> - [ ] ${l}`,
  (l) => `${l}\n===`,
  (l) => `| ${l} |\n| --- |`,
  (l) => `---\ntitle: Front\ntags: [a, b]\n---\n${l}`,
]

const markdownText = fc.string({
  unit: fc.oneof(
    {
      weight: 6,
      arbitrary: fc.constantFrom(
        ...'*_~`[]()!<>#-=|:\\^"/ \n\t'.split(''),
        '---\n',
        '```',
        '<!--',
        '-->',
        '[[',
        ']]',
        '](',
        '<a>',
        '<https:',
      ),
    },
    { weight: 2, arbitrary: fc.constantFrom('a', 'Z', '7', '.', ')', MEETING, '\r', '\f') },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 3 }) },
    { weight: 1, arbitrary: fc.constantFrom('\ud800', '\udc00') },
  ),
  maxLength: 200,
})

describe('readableText properties', () => {
  it('never throws, and folds whitespace into single spaces between words', () => {
    fc.assert(
      fc.property(markdownText, (markdown) => {
        const text = readableText(markdown)
        expect(text).not.toMatch(/^ | $|[ \t\n\r\f\v]{2}|[\t\n\r\f\v]/)
      }),
      { numRuns: 3000 },
    )
  })

  it('takes the markers out and keeps the words, which stay findable and marked', () => {
    const inline = fc.tuple(
      word,
      fc.nat(AROUND_WORD.length - 1),
      // Each emphasis character at most once around a word: markers of one character right
      // inside each other (`*_*w*_*`) pair the other way; four tildes opening a line make a fence.
      fc.array(fc.nat(INLINE.length - 1), { maxLength: 3 }).filter((wraps) => {
        const marks = wraps.map((k) => EMPHASIS[k]).filter((m) => m !== undefined)
        return new Set(marks).size === marks.length
      }),
    )
    fc.assert(
      fc.property(
        fc.array(inline, { minLength: 1, maxLength: 6 }),
        fc.nat(BLOCK.length - 1),
        fc.nat(),
        (words, block, pick) => {
          const line = words
            .map(([w, around, wraps]) =>
              wraps.reduce((text, k) => INLINE[k]!(text), AROUND_WORD[around]!(w)),
            )
            .join(' ')
          const markdown = `${BLOCK[block]!(line)}\n\n[ref]: https://devot.app`
          const text = words.map(([w]) => w).join(' ')
          expect(readableText(markdown)).toBe(text)

          const term = words[pick % words.length]![0]
          const excerpt = bodyExcerpt(markdown, [term])
          expect(excerpt).toBeDefined()
          const found = marked(excerpt, term)
          expect(found.length).toBeGreaterThan(0)
          for (const m of found) expect(m.toLowerCase()).toContain(term.toLowerCase())
        },
      ),
      { numRuns: 2000 },
    )
  })

  it('stays linear on input made to be slow', (context) => {
    const size = 200_000
    const inputs = [
      '['.repeat(size),
      '[['.repeat(size / 2) + ']]'.repeat(size / 2),
      '[^'.repeat(size / 2) + ']'.repeat(size / 2),
      '<!--'.repeat(size / 4),
      `[a <!--${'<!--'.repeat(size / 4)}](u) -->`,
      '<a:b'.repeat(size / 4),
      '`'.repeat(size),
      '*_~~'.repeat(size / 4),
      '['.repeat(size / 2) + '][]'.repeat(size / 2),
      `${'[x]('.repeat(size / 4)}${')'.repeat(size / 4)}`,
    ]
    const started = performance.now()
    for (const input of inputs) readableText(`x${input}\n${input}`)
    // Linear work takes well under a second; quadratic work takes minutes.
    expectWithinBudget(context, performance.now() - started, 10_000)
  }, 20_000)

  it('checks nested link destinations in linear time', (context) => {
    const k = 50_000
    const inputs = [
      // Every `(` opens a destination that runs to the one late space.
      `${'[a]('.repeat(k)} x${')'.repeat(k)}`,
      // Every `<` opens a destination that runs to the first `>`.
      '[a](<'.repeat(k) + '>)'.repeat(k),
    ]
    for (const input of inputs) {
      const started = performance.now()
      readableText(input)
      // Linear work takes milliseconds; quadratic work takes seconds.
      expectWithinBudget(context, performance.now() - started, 1_000)
    }
  })

  it('keeps code as written', () => {
    fc.assert(
      fc.property(word, (w) => {
        expect(readableText(`\`**${w}**\``)).toBe(`**${w}**`)
        expect(readableText(`\`\`\`\n# ${w} *x*\n\`\`\``)).toBe(`# ${w} *x*`)
      }),
    )
  })
})
