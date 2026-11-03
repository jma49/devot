import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../../tests/support/budget'
import { noteMarkdown } from '../markdown'
import { isRevealed, revealedLines, writeRanges, type Revealed, type WriteRange } from './rules'

const NOTE = '0192f0a2-7c1e-7d3a-9b2c-3d4e5f607182'

function rangesOf(
  doc: string,
  revealed: Revealed = [],
): { state: EditorState; ranges: WriteRange[] } {
  const state = EditorState.create({ doc, extensions: [noteMarkdown] })
  const tree = ensureSyntaxTree(state, doc.length, 1e9)
  if (!tree) throw new Error('E_TEST_NO_TREE')
  return { state, ranges: writeRanges(state, tree, revealed) }
}

const STAND_IN: Record<string, (r: WriteRange) => string> = {
  bullet: (r) => (r.kind === 'bullet' ? `{bullet${r.depth}}` : ''),
  task: (r) => (r.kind === 'task' ? (r.done ? '{done}' : '{todo}') : ''),
  alert: (r) => (r.kind === 'alert' ? `{${r.alert}}` : ''),
  noteTitle: (r) => (r.kind === 'noteTitle' ? `{note ${r.id}}` : ''),
}

/** The note as Write mode shows it: hidden marks gone, widgets as `{…}`. */
function shown(doc: string, revealed: Revealed = []): string {
  const replaced = rangesOf(doc, revealed)
    .ranges.filter((r) => r.kind !== 'mark' && r.kind !== 'line')
    .sort((a, b) => a.from - b.from)
  let out = ''
  let at = 0
  for (const r of replaced) {
    expect(r.from).toBeGreaterThanOrEqual(at)
    out += doc.slice(at, r.from) + (STAND_IN[r.kind]?.(r) ?? '')
    at = r.to
  }
  return out + doc.slice(at)
}

const marks = (doc: string) =>
  rangesOf(doc)
    .ranges.filter((r) => r.kind === 'mark' || r.kind === 'line')
    .map((r) =>
      r.kind === 'mark' || r.kind === 'line' ? `${r.className} ${doc.slice(r.from, r.to)}` : '',
    )

describe('Write mode hides inline marks', () => {
  it('of bold, italic, strikethrough, inline code and highlight', () => {
    expect(shown('a **bold** b')).toBe('a bold b')
    expect(shown('a *it* and _it_ b')).toBe('a it and it b')
    expect(shown('***both***')).toBe('both')
    expect(shown('~~gone~~')).toBe('gone')
    expect(shown('run `npm i` now')).toBe('run npm i now')
    expect(shown('run ``a ` b`` now')).toBe('run a ` b now')
    expect(shown('a <mark>lit</mark> b')).toBe('a lit b')
  })

  it('of escapes, keeping the character escaped', () => {
    expect(shown('2 \\* 3 \\_x\\_')).toBe('2 * 3 _x_')
  })

  it('leaves marks that open nothing as typed', () => {
    expect(shown('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(shown('a </mark> b')).toBe('a </mark> b')
    expect(shown('snake_case_name')).toBe('snake_case_name')
  })
})

describe('Write mode links', () => {
  it('show their text, the address hidden', () => {
    expect(shown('see [the docs](https://example.com "Title") now')).toBe('see the docs now')
    expect(shown('[**bold** link](https://example.com)')).toBe('bold link')
    expect(shown('<https://example.com>')).toBe('https://example.com')
  })

  it('by reference hide the label, and a shortcut reference stays as typed', () => {
    expect(shown('[text][ref]\n\n[ref]: https://example.com')).toBe(
      'text\n\n[ref]: https://example.com',
    )
    expect(shown('a [x] b')).toBe('a [x] b')
  })

  it('to a note show the text as a chip, or the title when the text is empty', () => {
    expect(shown(`[Plan](devot://note/${NOTE})`)).toBe('Plan')
    expect(marks(`[Plan](devot://note/${NOTE})`)).toEqual(['cm-wm-note-chip Plan'])
    expect(shown(`see [](devot://note/${NOTE}).`)).toBe(`see {note ${NOTE}}.`)
  })

  it('leave images to the image rules', () => {
    expect(shown('![alt](a.png)')).toBe('![alt](a.png)')
  })
})

describe('Write mode headings', () => {
  it('hide the number signs and the space after them', () => {
    expect(shown('# One\n## Two\n###### Six')).toBe('One\nTwo\nSix')
    expect(shown('## Closed ##')).toBe('Closed')
    expect(shown('#')).toBe('')
  })

  it('hide a setext underline', () => {
    expect(shown('Title\n=====\n\nSub\n---')).toBe('Title\n\n\nSub\n')
  })

  it('leave a number sign that is no heading', () => {
    expect(shown('#hashtag and C#')).toBe('#hashtag and C#')
  })
})

describe('Write mode quotes and alerts', () => {
  it('hide the quote marks of every line', () => {
    expect(shown('> one\n> two\n>\n> > deep')).toBe('one\ntwo\n\ndeep')
  })

  it('show an alert kind as its label', () => {
    expect(shown('> [!WARNING]\n> Careful')).toBe('{warning}\nCareful')
    expect(shown('> [!tip]  \n> Try')).toBe('{tip}  \nTry')
  })

  it('leave a label that is no alert kind', () => {
    expect(shown('> [!OTHER]\n> x')).toBe('[!OTHER]\nx')
  })
})

describe('Write mode lists and tasks', () => {
  it('show a bullet for a bullet list mark, by depth, and keep numbers', () => {
    expect(shown('- a\n  * b\n    + c')).toBe('{bullet1} a\n  {bullet2} b\n    {bullet3} c')
    expect(shown('1. one\n2. two')).toBe('1. one\n2. two')
  })

  it('show a checkbox in place of a task box and its list mark', () => {
    expect(shown('- [ ] open\n- [x] done\n- [X] also')).toBe(
      '{todo} open\n{done} done\n{done} also',
    )
    expect(shown('1. [ ] first')).toBe('1. {todo} first')
  })

  it('in a quote hide the quote mark too', () => {
    expect(shown('> - item')).toBe('{bullet1} item')
  })
})

describe('Write mode rules', () => {
  it('draw a horizontal rule as a line', () => {
    expect(shown('a\n\n---\n\nb')).toBe('a\n\n\n\nb')
    expect(marks('a\n\n***\n\nb')).toEqual(['cm-wm-rule '])
  })

  it('leave code, tables, HTML blocks and front matter as source', () => {
    const blocks = [
      '```js\nconst a = `x` * 2 // **no**\n```',
      '    indented **code**',
      '| **a** | b |\n| - | - |\n| `c` | d |',
      '<div>\n**raw**\n</div>',
      '---\ntitle: **x**\n---',
    ]
    for (const doc of blocks) expect(shown(doc)).toBe(doc)
  })
})

describe('the lines with the selection', () => {
  const at = (doc: string, ranges: [number, number][], focused = true) =>
    revealedLines(
      EditorState.create({
        doc,
        selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))),
        extensions: [EditorState.allowMultipleSelections.of(true)],
      }),
      focused,
    )

  it('show their source, and only theirs', () => {
    const doc = '# One\n**two**\n# Three'
    const revealed = at(doc, [[8, 8]])
    expect(revealed).toEqual([{ first: 2, last: 2 }])
    expect(shown(doc, revealed)).toBe('One\n**two**\nThree')
  })

  it('cover every line a selection touches and every caret of several', () => {
    const doc = 'a\nb\nc\nd\ne\nf'
    expect(at(doc, [[0, 4]])).toEqual([{ first: 1, last: 3 }])
    expect(
      at(doc, [
        [10, 10],
        [0, 0],
        [2, 2],
      ]),
    ).toEqual([
      { first: 1, last: 2 },
      { first: 6, last: 6 },
    ])
  })

  it('leave out a caret while the editor has no keyboard, never a selection', () => {
    const doc = '**a**\n**b**'
    expect(at(doc, [[1, 1]], false)).toEqual([])
    expect(at(doc, [[0, 3]], false)).toEqual([{ first: 1, last: 1 }])
  })

  it('are found by line number', () => {
    const revealed = [
      { first: 2, last: 4 },
      { first: 9, last: 9 },
    ]
    expect([1, 2, 4, 5, 9, 10].map((n) => isRevealed(revealed, n))).toEqual([
      false,
      true,
      true,
      false,
      true,
      false,
    ])
  })

  it('keep a mark that spans lines on the lines it is on', () => {
    const doc = '**one\ntwo**'
    expect(shown(doc, [{ first: 1, last: 1 }])).toBe('**one\ntwo')
  })
})

describe('Write mode ranges of a long note', () => {
  it('are read for the shown part only, in a fraction of a frame', (context) => {
    const block =
      '## Part\n\nSome **bold**, *italic* and [a link](https://example.com).\n\n- [ ] task\n- item\n\n> quote\n\n'
    const doc = block.repeat(4_000)
    const state = EditorState.create({ doc, extensions: [noteMarkdown] })
    const tree = ensureSyntaxTree(state, doc.length, 1e9)
    if (!tree) throw new Error('E_TEST_NO_TREE')
    const from = state.doc.line(20_000).from
    const to = state.doc.line(20_060).to
    const started = performance.now()
    const ranges = writeRanges(state, tree, [], from, to)
    expectWithinBudget(context, performance.now() - started, 8)
    expect(ranges.length).toBeGreaterThan(20)
    expect(ranges.every((r) => r.to >= from - block.length && r.from <= to + block.length)).toBe(
      true,
    )
  })
})
