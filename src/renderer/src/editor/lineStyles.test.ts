import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { decorationsFor, markdownGutterLines, lineStyles, type LineStyle } from './lineStyles'
import { noteMarkdown } from './markdown'

function stylesOf(doc: string): { state: EditorState; styles: LineStyle[] } {
  const state = EditorState.create({ doc, extensions: [noteMarkdown] })
  const tree = ensureSyntaxTree(state, doc.length, 1e9)
  if (!tree) throw new Error('E_TEST_NO_TREE')
  return { state, styles: lineStyles(state, tree) }
}

function lineClasses(doc: string): Record<number, string> {
  const { state, styles } = stylesOf(doc)
  const out: Record<number, string> = {}
  decorationsFor(state, styles).between(0, doc.length, (from, to, deco) => {
    if (from === to && deco.spec.class) out[state.doc.lineAt(from).number] = deco.spec.class
  })
  return out
}

function marked(doc: string, className: string): string[] {
  return stylesOf(doc)
    .styles.filter((s) => !s.line && s.className.split(' ').includes(className))
    .map((s) => doc.slice(s.from, s.to))
}

describe('the line styles of a long table or quote', () => {
  it('cover only the shown lines, and keep the first and last of the whole node', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `| ${i} | x |`)
    const doc = ['| a | b |', '| - | - |', ...rows].join('\n')
    const { state, styles } = stylesOf(doc)
    const shown = [{ from: state.doc.line(500).from, to: state.doc.line(501).to }]
    const classes = (ranges: { from: number; to: number }[]) => {
      const out: string[] = []
      decorationsFor(state, styles, ranges).between(0, doc.length, (from, to, deco) => {
        if (from === to) out.push(`${state.doc.lineAt(from).number} ${deco.spec.class}`)
      })
      return out
    }
    expect(classes(shown)).toEqual(['500 cm-md-table', '501 cm-md-table'])
    const ends = [
      { from: 0, to: 0 },
      { from: state.doc.length, to: state.doc.length },
    ]
    expect(classes(ends)).toEqual([
      '1 cm-md-table cm-md-table-first',
      '1002 cm-md-table cm-md-table-last',
    ])
  })
})

describe('editor line styles', () => {
  it('gives heading lines their level', () => {
    const lines = lineClasses('# One\n\n## Two\n\n### Three\n\n#### Four\n\nTitle\n=====\n')
    expect(lines[1]).toBe('cm-md-heading cm-md-h1')
    expect(lines[3]).toBe('cm-md-heading cm-md-h2')
    expect(lines[5]).toBe('cm-md-heading cm-md-h3')
    expect(lines[7]).toBe('cm-md-heading cm-md-h4')
    expect(lines[9]).toBe('cm-md-heading cm-md-h1')
  })

  it('marks list marks at the second level (and the fourth) apart', () => {
    const doc = '- one\n  - two\n    - three\n      - four\n'
    const alt = stylesOf(doc).styles.filter((s) => s.className === 'cm-md-list-alt')
    const lineOf = (pos: number) => doc.slice(0, pos).split('\n').length
    expect(alt.map((s) => lineOf(s.from))).toEqual([2, 4])
    expect(alt.map((s) => doc.slice(s.from, s.to))).toEqual(['-', '-'])
  })

  it('puts the inline code chip around the code only, leaving the backticks out', () => {
    expect(marked('Run `make test` now, or ``a ` b``.', 'cm-md-code')).toEqual([
      'make test',
      'a ` b',
    ])
  })

  it('strikes through the text of a done task only', () => {
    expect(marked('- [x] shipped\n- [ ] open\n', 'cm-md-task-done')).toEqual([' shipped'])
  })

  it('highlights the text between mark tags and shrinks the tags', () => {
    const doc = 'A <mark>key</mark> word'
    expect(marked(doc, 'cm-md-mark')).toEqual(['key'])
    expect(marked(doc, 'cm-md-mark-tag')).toEqual(['<mark>', '</mark>'])
  })

  it('draws quotes with a bar and alerts in their kind', () => {
    const doc = '> plain\n\n> [!WARNING]\n> careful\n'
    const lines = lineClasses(doc)
    expect(lines[1]).toBe('cm-md-quote cm-md-quote-first cm-md-quote-last')
    expect(lines[3]).toBe('cm-md-quote cm-md-alert cm-md-alert-warning cm-md-alert-first')
    expect(lines[4]).toBe('cm-md-quote cm-md-alert cm-md-alert-warning cm-md-alert-last')
    expect(marked(doc, 'cm-md-alert-label')).toEqual(['[!WARNING]'])
  })

  it('marks only the outer lines of a long quote or alert', () => {
    const lines = lineClasses('> a\n> b\n> c\n\n> [!NOTE]\n> d\n> e\n')
    expect(lines[1]).toBe('cm-md-quote cm-md-quote-first')
    expect(lines[2]).toBe('cm-md-quote')
    expect(lines[3]).toBe('cm-md-quote cm-md-quote-last')
    expect(lines[5]).toBe('cm-md-quote cm-md-alert cm-md-alert-note cm-md-alert-first')
    expect(lines[6]).toBe('cm-md-quote cm-md-alert cm-md-alert-note')
    expect(lines[7]).toBe('cm-md-quote cm-md-alert cm-md-alert-note cm-md-alert-last')
  })

  it('boxes a table and makes its header row bold', () => {
    const doc = 'Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    const lines = lineClasses(doc)
    expect(lines[1]).toBeUndefined()
    expect(lines[3]).toBe('cm-md-table cm-md-table-first')
    expect(lines[4]).toBe('cm-md-table')
    expect(lines[5]).toBe('cm-md-table cm-md-table-last')
    expect(marked(doc, 'cm-md-table-header')).toEqual(['| a | b |'])
  })
})

describe('the gutter', () => {
  it("pads a table's first line, as the line is padded inside its box", () => {
    const s = EditorState.create({
      doc: 'a\n\n| x | y |\n| - | - |\n| 1 | 2 |',
      extensions: [noteMarkdown],
    })
    ensureSyntaxTree(s, s.doc.length, 5000)
    const lines: string[] = []
    for (let c = markdownGutterLines(s).iter(); c.value; c.next())
      lines.push(`${s.doc.lineAt(c.from).number}:${c.value.elementClass}`)
    expect(lines).toEqual(['3:cm-md-gutter-table'])
  })

  it('puts the number of a heading on its baseline, on every line', () => {
    const s = EditorState.create({
      doc: '# One\n\ntext\n\n### Three\n\n#### Four\n\nTwo\n---\n\n```\n# not\n```',
      extensions: [noteMarkdown],
    })
    ensureSyntaxTree(s, s.doc.length, 5000)
    const lines: string[] = []
    for (let c = markdownGutterLines(s).iter(); c.value; c.next())
      lines.push(`${s.doc.lineAt(c.from).number}:${c.value.elementClass}`)
    expect(lines).toEqual([
      '1:cm-md-gutter-h1',
      '5:cm-md-gutter-h3',
      '7:cm-md-gutter-h4',
      '9:cm-md-gutter-h2',
      '10:cm-md-gutter-h2',
    ])
  })
})
