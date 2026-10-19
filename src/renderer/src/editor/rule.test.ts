import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { FORMAT_COMMANDS } from './formats'
import { noteMarkdown, noteParser } from './markdown'
import { insertRule } from './rule'

// `|` marks a cursor, `«` and `»` a selected range.
function state(marked: string) {
  const ranges = []
  let doc = ''
  let start = -1
  for (const ch of marked) {
    if (ch === '«') start = doc.length
    else if (ch === '»') ranges.push(EditorSelection.range(start, doc.length))
    else if (ch === '|') ranges.push(EditorSelection.cursor(doc.length))
    else doc += ch
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
    extensions: [EditorState.allowMultipleSelections.of(true), noteMarkdown, history()],
  })
}

function show(s: EditorState): string {
  const marks: [number, string][] = []
  for (const r of s.selection.ranges) {
    if (r.empty) marks.push([r.from, '|'])
    else marks.push([r.from, '«'], [r.to, '»'])
  }
  let text = s.doc.toString()
  for (const [pos, mark] of marks.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, pos) + mark + text.slice(pos)
  return text
}

function apply(s: EditorState, spec: TransactionSpec | null): EditorState {
  expect(spec).not.toBeNull()
  return s.update(spec!).state
}

const rule = (marked: string) => show(apply(state(marked), insertRule(state(marked))))

const blocks = (text: string) => {
  const names: string[] = []
  const top = noteParser.parse(text).topNode
  for (let child = top.firstChild; child; child = child.nextSibling) names.push(child.name)
  return names
}

describe('insertRule', () => {
  it('takes the place of an empty list item or heading', () => {
    expect(rule('- a\n- |')).toBe('- a\n\n---\n|')
    expect(rule('Intro\n\n## |')).toBe('Intro\n\n---\n|')
    expect(rule('Title\n-|')).toBe('Title\n-\n\n---\n|')
  })

  it('keeps paragraph text that only looks like an empty list item', () => {
    // An empty item cannot interrupt a paragraph: these lines are its text.
    expect(rule('Total\n2020.|')).toBe('Total\n2020.\n\n---\n|')
    expect(rule('Total\n42.|')).toBe('Total\n42.\n\n---\n|')
    expect(rule('Total\n*|')).toBe('Total\n*\n\n---\n|')
    expect(rule('Total\n+|')).toBe('Total\n+\n\n---\n|')
    expect(rule('- [ ]|')).toBe('- [ ]\n\n---\n|')
  })

  it('puts a rule after the line, with a blank line before it, and the cursor below', () => {
    expect(rule('First| line\nNext')).toBe('First line\n\n---\n|\nNext')
    expect(rule('Last line|')).toBe('Last line\n\n---\n|')
    // A rule right under text would make it a heading: the blank line keeps it a rule.
    expect(blocks('Last line\n\n---\n')).toEqual(['Paragraph', 'HorizontalRule'])
  })

  it('fills a blank line, keeping a blank line from the text above', () => {
    expect(rule('Text\n|\nMore')).toBe('Text\n\n---\n|\nMore')
    expect(rule('Text\n\n|')).toBe('Text\n\n---\n|')
    expect(rule('# Title\n\n|\n')).toBe('# Title\n\n---\n|\n')
  })

  it('does not start a note with a fence that could open front matter', () => {
    expect(rule('|')).toBe('***\n|')
    expect(rule('|\nText')).toBe('***\n|\nText')
    // A note that starts with a rule: a second `---` would close front matter.
    expect(rule('---\nText|')).toBe('---\nText\n\n***\n|')
    expect(blocks('---\nText\n\n***\n')).toEqual(['HorizontalRule', 'Paragraph', 'HorizontalRule'])
    expect(blocks('***\n\nText\n\n---\n')).toEqual([
      'HorizontalRule',
      'Paragraph',
      'HorizontalRule',
    ])
  })

  it('goes after the line a selection ends on, leaving the selected text alone', () => {
    expect(rule('«One\nTwo»\nThree')).toBe('One\nTwo\n\n---\n|\nThree')
    expect(rule('«One\n»Two')).toBe('One\n\n---\n|\nTwo')
  })

  it('stays in a quote', () => {
    expect(rule('> Quoted| text\n> more')).toBe('> Quoted text\n>\n> ---\n> |\n> more')
    expect(rule('> |')).toBe('> ---\n> |')
  })

  it('goes after a table or a setext heading, not inside it', () => {
    // Table pipes would read as cursors here: place the cursor by offset.
    const table = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter'
    const inRow = state('').update({
      changes: { from: 0, insert: table },
      selection: { anchor: table.indexOf('1') },
    }).state
    const after = apply(inRow, insertRule(inRow))
    expect(after.doc.toString()).toBe(
      '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\n---\n\n\nAfter',
    )
    expect(after.selection.main.head).toBe(table.indexOf('\n\nAfter') + '\n\n---\n'.length)
    expect(rule('Title|\n=====\nText')).toBe('Title\n=====\n\n---\n|\nText')
  })

  it('inserts one rule after each line with a cursor', () => {
    expect(rule('A| and |b\nC|')).toBe('A and b\n\n---\n|\nC\n\n---\n|')
  })

  it('does nothing in code, HTML or front matter', () => {
    for (const marked of [
      '```\ncode|\n```',
      '    indented| code',
      '<div>\nhtml|\n</div>',
      '---\ntitle: x|\n---\nText',
    ]) {
      expect({ marked, result: insertRule(state(marked)) }).toEqual({ marked, result: null })
    }
  })

  it('is one undo step', () => {
    const before = state('Text|')
    const after = apply(before, insertRule(before))
    expect(show(after)).toBe('Text\n\n---\n|')
    let undone = after
    undo({ state: after, dispatch: (tr) => (undone = tr.state) })
    expect(show(undone)).toBe('Text|')
  })

  it('is the horizontalRule format', () => {
    const s = state('Text|')
    expect(FORMAT_COMMANDS.horizontalRule(s)).toEqual(insertRule(s))
  })
})
