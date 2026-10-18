import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState, type ChangeSpec } from '@codemirror/state'
import { gutterLineClass, GutterMarker } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { codeBlocks } from './codeBlocks'
import { markerField, type MarkerScan } from './gutterMarkers'
import { markdownLineStyles } from './lineStyles'
import { noteMarkdown } from './markdown'

/** Every marker the state's gutter-class sets hold, as `line:class`. */
function markers(s: EditorState): string[] {
  const out: string[] = []
  for (const set of s.facet(gutterLineClass))
    for (let c = set.iter(); c.value; c.next())
      out.push(`${s.doc.lineAt(c.from).number}:${c.value.elementClass}`)
  return out.sort()
}

const make = (doc: string) => {
  const s = EditorState.create({
    doc,
    extensions: [noteMarkdown, codeBlocks(), markdownLineStyles],
  })
  ensureSyntaxTree(s, s.doc.length, 5000)
  return s.update({}).state
}

/** The markers of a state made from scratch from the same text. */
const fresh = (s: EditorState) => markers(make(s.doc.toString()))

const DOC = [
  '# One',
  '',
  'text',
  '',
  '```js',
  'code',
  '```',
  '',
  '| x | y |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  'Two',
  '---',
  '',
  '- item',
  '  ```',
  '  # not',
  '  ```',
  '',
  '## Last',
].join('\n')

describe('the gutter line classes after an edit', () => {
  const edits: [string, (s: EditorState) => ChangeSpec][] = [
    ['typing in a paragraph', (s) => ({ from: s.doc.line(3).to, insert: 'x' })],
    ['a new heading', (s) => ({ from: s.doc.line(3).from, insert: '### ' })],
    ['a heading made text', () => ({ from: 0, to: 2 })],
    ['an opened fence', (s) => ({ from: s.doc.line(3).from, insert: '```\n' })],
    ['a closing fence removed', (s) => ({ from: s.doc.line(7).from, to: s.doc.line(7).to })],
    ['a table row added', (s) => ({ from: s.doc.line(11).to, insert: '\n| 3 | 4 |' })],
    ['the table header removed', (s) => ({ from: s.doc.line(9).from, to: s.doc.line(10).to + 1 })],
    ['the setext underline removed', (s) => ({ from: s.doc.line(13).to, to: s.doc.line(14).to })],
    ['a block in the item deleted', (s) => ({ from: s.doc.line(16).to, to: s.doc.line(19).to })],
    [
      'two edits at once',
      (s) => [
        { from: 0, insert: '#' },
        { from: s.doc.line(21).from, to: s.doc.line(21).from + 3 },
      ],
    ],
    ['the whole note replaced', (s) => ({ from: 0, to: s.doc.length, insert: '```\nx' })],
  ]

  for (const [name, edit] of edits)
    it(`match a fresh scan: ${name}`, () => {
      const s = make(DOC)
      expect(markers(s)).toEqual(fresh(s))
      const t = s.update({ changes: edit(s) }).state
      ensureSyntaxTree(t, t.doc.length, 5000)
      // The parser's catch-up comes with the next transaction.
      expect(markers(t.update({}).state)).toEqual(fresh(t))
    })

  it('match a fresh scan through many edits in a row', () => {
    let s = make(DOC)
    for (const at of [3, 40, 12, 0, 70, 20]) {
      s = s.update({
        changes: {
          from: Math.min(at, s.doc.length),
          insert: at % 2 ? '# ' : '`',
        },
      }).state
      ensureSyntaxTree(s, s.doc.length, 5000)
      s = s.update({}).state
      expect(markers(s)).toEqual(fresh(s))
    }
  })
})

describe('the gutter line classes under random edits', () => {
  // A small seeded generator, so a failure repeats.
  function random(seed: number) {
    let x = seed
    return (n: number) => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0
      return x % n
    }
  }
  const PIECES = [
    '# h',
    '## h',
    '```',
    '```js',
    '| a | b |',
    '| - | - |',
    '- ',
    '> ',
    '  ',
    'text',
    '---',
    '  ```',
    '- ```',
    '> ```',
    '    ',
    '===',
    '1. ',
    '- # h',
    '> # h',
    '',
    '\n',
    '\n\n',
  ]

  for (let seed = 1; seed <= 40; seed++)
    it(`match a fresh scan (seed ${seed})`, () => {
      const rnd = random(seed)
      const pick = () => PIECES[rnd(PIECES.length)] ?? ''
      let s = make(Array.from({ length: 15 }, pick).join('\n'))
      for (let i = 0; i < 15; i++) {
        const from = rnd(s.doc.length + 1)
        const to = Math.min(s.doc.length, from + (rnd(3) === 0 ? rnd(12) : 0))
        s = s.update({ changes: { from, to, insert: pick() } }).state
        ensureSyntaxTree(s, s.doc.length, 5000)
        s = s.update({}).state
        expect(markers(s)).toEqual(fresh(s))
      }
    })

  it('catch up when the parser reaches the rest of a long note later', () => {
    const doc = Array.from(
      { length: 6000 },
      (_, i) => `# h${i}\n\n\`\`\`\ncode ${i}\n\`\`\`\n`,
    ).join('\n')
    let s = EditorState.create({
      doc,
      extensions: [noteMarkdown, codeBlocks(), markdownLineStyles],
    })
    for (const at of [5, 100, 40]) s = s.update({ changes: { from: at, insert: 'x' } }).state
    ensureSyntaxTree(s, s.doc.length, 20000)
    s = s.update({}).state
    expect(markers(s)).toEqual(fresh(s))
  })
})

describe('scanning for the gutter line classes', () => {
  /** A scan that counts the text it looks at. */
  function counting() {
    let looked = 0
    const scan: MarkerScan = (state, from, to, mark) => {
      looked += to - from
      syntaxTree(state).iterate({
        from,
        to,
        enter: (n) => {
          if (n.name !== 'ATXHeading1') return undefined
          mark(state.doc.lineAt(n.from).from, marker)
          return false
        },
      })
    }
    return { scan, looked: () => looked, reset: () => (looked = 0) }
  }
  const marker = new (class extends GutterMarker {})()

  it('looks only at the changed line, not the note, on a keystroke', () => {
    const doc = Array.from({ length: 3000 }, (_, i) => `# h${i}\n\ntext ${i}\n`).join('\n')
    const { scan, looked, reset } = counting()
    const field = markerField(scan)
    const s = EditorState.create({ doc, extensions: [noteMarkdown, field] })
    ensureSyntaxTree(s, s.doc.length, 5000)
    const t = s.update({}).state
    reset()
    const edited = t.update({ changes: { from: 10, insert: 'x' } }).state
    expect(edited.doc.length).toBe(doc.length + 1)
    expect(looked()).toBeLessThan(200)
  })
  it('looks only at the quote or list the edit is in, among many', () => {
    for (const mark of ['> ', '- ']) {
      const doc = Array.from({ length: 3000 }, (_, i) => `${mark}# h${i}\n\ntext\n\n`).join('')
      const { scan, looked, reset } = counting()
      const s = EditorState.create({ doc, extensions: [noteMarkdown, markerField(scan)] })
      ensureSyntaxTree(s, s.doc.length, 5000)
      const t = s.update({}).state
      reset()
      const edited = t.update({ changes: { from: doc.indexOf('h1500') + 1, insert: 'x' } }).state
      expect(edited.doc.length).toBe(doc.length + 1)
      expect([mark, looked() < 2000]).toEqual([mark, true])
    }
  })
})
