import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { decorationsFor, lineStyles, type LineStyle } from './lineStyles'
import { noteMarkdown } from './markdown'

function stylesOf(doc: string): { state: EditorState; styles: LineStyle[] } {
  const state = EditorState.create({ doc, extensions: [noteMarkdown] })
  const tree = ensureSyntaxTree(state, doc.length, 1e9)
  if (!tree) throw new Error('E_TEST_NO_TREE')
  return { state, styles: lineStyles(state, tree) }
}

/** The classes on each line, by line number. */
function lineClasses(doc: string): Record<number, string> {
  const { state, styles } = stylesOf(doc)
  const out: Record<number, string> = {}
  decorationsFor(state, styles).between(0, doc.length, (from, to, deco) => {
    if (from === to && deco.spec.class) out[state.doc.lineAt(from).number] = deco.spec.class
  })
  return out
}

/** The text each mark with `className` covers. */
function marked(doc: string, className: string): string[] {
  return stylesOf(doc)
    .styles.filter((s) => !s.line && s.className.split(' ').includes(className))
    .map((s) => doc.slice(s.from, s.to))
}

describe('editor line styles', () => {
  it('gives heading lines their level, up to level 3', () => {
    const lines = lineClasses('# One\n\n## Two\n\n### Three\n\n#### Four\n\nTitle\n=====\n')
    expect(lines[1]).toBe('cm-md-heading cm-md-h1')
    expect(lines[3]).toBe('cm-md-heading cm-md-h2')
    expect(lines[5]).toBe('cm-md-heading cm-md-h3')
    // Level 4 and below are body size.
    expect(lines[7]).toBeUndefined()
    // A setext heading takes its level too.
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
    expect(lines[1]).toBe('cm-md-quote')
    expect(lines[3]).toBe('cm-md-quote cm-md-alert cm-md-alert-warning')
    expect(lines[4]).toBe('cm-md-quote cm-md-alert cm-md-alert-warning')
    expect(marked(doc, 'cm-md-alert-label')).toEqual(['[!WARNING]'])
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
