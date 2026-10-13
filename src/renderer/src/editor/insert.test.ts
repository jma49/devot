import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { INSERT_COMMANDS, insertImage, insertNoteLink, insertTable } from './insert'
import { noteMarkdown, noteParser } from './markdown'

// `^` marks a cursor and `«` `»` a selected range (`|` is a table's pipe here).
function state(marked: string) {
  const ranges = []
  let doc = ''
  let start = -1
  for (const ch of marked) {
    if (ch === '«') start = doc.length
    else if (ch === '»') ranges.push(EditorSelection.range(start, doc.length))
    else if (ch === '^') ranges.push(EditorSelection.cursor(doc.length))
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
    if (r.empty) marks.push([r.from, '^'])
    else marks.push([r.from, '«'], [r.to, '»'])
  }
  let text = s.doc.toString()
  for (const [pos, mark] of marks.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, pos) + mark + text.slice(pos)
  return text
}

type Insert = (s: EditorState) => TransactionSpec | null

/** The marked text after the insertion, or null when it does nothing. */
function run(insert: Insert, marked: string): string | null {
  const s = state(marked)
  const spec = insert(s)
  return spec ? show(s.update(spec).state) : null
}

/** The block nodes the parser reads in a text. */
const blocks = (text: string) => {
  const names: string[] = []
  const top = noteParser.parse(text).topNode
  for (let child = top.firstChild; child; child = child.nextSibling) names.push(child.name)
  return names
}

const TABLE = ['| ^    |     |', '| --- | --- |', '|     |     |'].join('\n')

describe('insertImage', () => {
  it('inserts an empty image at a cursor, the cursor in its text', () => {
    expect(run(insertImage, 'See ^')).toBe('See ![^]()')
    expect(run(insertImage, '^')).toBe('![^]()')
  })

  it('makes selected text the image text, and a selected address its address', () => {
    expect(run(insertImage, 'a «cat» b')).toBe('a ![cat](^) b')
    expect(run(insertImage, '«https://example.com/a.png»')).toBe('![^](https://example.com/a.png)')
  })

  it('does nothing in code, front matter or a link', () => {
    expect(run(insertImage, 'x `co^de` y')).toBeNull()
    expect(run(insertImage, '```\n^\n```')).toBeNull()
    expect(run(insertImage, '---\ntitle: ^\n---\n')).toBeNull()
    expect(run(insertImage, '[li^nk](https://example.com)')).toBeNull()
  })
})

describe('insertNoteLink', () => {
  it('inserts `[[]]` with the cursor inside, where the note popup reads its query', () => {
    expect(run(insertNoteLink, 'See ^')).toBe('See [[^]]')
  })

  it('takes selected text as the query', () => {
    expect(run(insertNoteLink, 'See «Groceries» now')).toBe('See [[Groceries^]] now')
  })

  it('does nothing for a query the popup cannot read, or in code and links', () => {
    expect(run(insertNoteLink, '«two\nlines»')).toBeNull()
    expect(run(insertNoteLink, '«[x]»')).toBeNull()
    // A pipe would end a table cell.
    expect(run(insertNoteLink, '| «a | b» |\n| --- | --- |')).toBeNull()
    expect(run(insertNoteLink, 'x `co^de` y')).toBeNull()
    expect(run(insertNoteLink, '    code^')).toBeNull()
    expect(run(insertNoteLink, '[li^nk](https://example.com)')).toBeNull()
  })
})

describe('insertTable', () => {
  it('puts an empty table on a blank line, the cursor in its first cell', () => {
    expect(run(insertTable, '^')).toBe(TABLE)
    expect(blocks(TABLE.replace('^', ''))).toEqual(['Table'])
  })

  it('goes after a line of text, with blank lines around it', () => {
    expect(run(insertTable, 'Text^')).toBe(`Text\n\n${TABLE}`)
    expect(run(insertTable, 'Te^xt\nNext')).toBe(`Text\n\n${TABLE}\n\nNext`)
    expect(run(insertTable, 'Above\n^\nBelow')).toBe(`Above\n\n${TABLE}\n\nBelow`)
    expect(run(insertTable, 'Above\n\n^\n\nBelow')).toBe(`Above\n\n${TABLE}\n\nBelow`)
    // Without the blank lines the text above would be its header and the text below a row.
    const text = run(insertTable, 'Text^\nNext')!.replace('^', '')
    expect(blocks(text)).toEqual(['Paragraph', 'Table', 'Paragraph'])
  })

  it('takes the place of an empty list item or heading', () => {
    expect(run(insertTable, '- ^')).toBe(TABLE)
    expect(run(insertTable, '- a\n- ^')).toBe(`- a\n\n${TABLE}`)
    expect(run(insertTable, '1. [ ] ^\nNext')).toBe(`${TABLE}\n\nNext`)
    expect(run(insertTable, '## ^')).toBe(TABLE)
    // A setext underline is not an empty item: the table goes after the heading.
    expect(run(insertTable, 'Title\n-^')).toBe(`Title\n-\n\n${TABLE}`)
  })

  it('keeps paragraph text that only looks like an empty list item', () => {
    for (const text of ['2020.', '42.', '*', '+'])
      expect(run(insertTable, `Total\n${text}^`)).toBe(`Total\n${text}\n\n${TABLE}`)
  })

  it('keeps the tables of cursors on adjacent lines apart', () => {
    expect(run(insertTable, '^\n^')).toBe(`${TABLE}\n\n${TABLE}`)
    expect(run(insertTable, '^\n^\n^')).toBe(`${TABLE}\n\n${TABLE}\n\n${TABLE}`)
    expect(run(insertTable, 'Text^\n^')).toBe(`Text\n\n${TABLE}\n\n${TABLE}`)
    const text = run(insertTable, '^\n^')!.replaceAll('^', '')
    expect(blocks(text)).toEqual(['Table', 'Table'])
  })

  it('stays in a quote', () => {
    const quoted = TABLE.split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    expect(run(insertTable, '> Quote^')).toBe(`> Quote\n>\n${quoted}`)
  })

  it('does nothing in code or front matter', () => {
    expect(run(insertTable, '```\n^\n```')).toBeNull()
    expect(run(insertTable, '    code^')).toBeNull()
    expect(run(insertTable, '---\ntitle: ^\n---\n')).toBeNull()
  })

  it('is one undo step', () => {
    const s = state('Text^\nNext')
    const after = s.update(insertTable(s)!).state
    let undone = after
    undo({ state: after, dispatch: (tr) => (undone = tr.state) })
    expect(show(undone)).toBe('Text^\nNext')
  })
})

describe('INSERT_COMMANDS', () => {
  it('has a command for each insertion', () => {
    expect(Object.keys(INSERT_COMMANDS).sort()).toEqual(['image', 'noteLink', 'table'])
  })
})
