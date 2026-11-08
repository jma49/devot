import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { Nodes as MdastNode } from 'mdast'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../../tests/support/budget'
import { isInlineTex } from '../../../../core/preview/math'
import example from '../../welcome/markdown-example.md?raw'
import { noteMarkdown } from '../markdown'
import { writeBlocksOf } from './blockRanges'
import { writeRanges, type WriteRange } from './rules'
import { isRevealed, revealedLines, selectedRanges, touches, type Selected } from './selection'

const NOTE = '0192f0a2-7c1e-7d3a-9b2c-3d4e5f607182'

function rangesOf(
  doc: string,
  selected: Selected = [],
): { state: EditorState; ranges: WriteRange[] } {
  const state = EditorState.create({ doc, extensions: [noteMarkdown] })
  const tree = ensureSyntaxTree(state, doc.length, 1e9)
  if (!tree) throw new Error('E_TEST_NO_TREE')
  return { state, ranges: writeRanges(state, tree, selected) }
}

/** A caret at `pos`, or a selection from `pos` to `to`. */
const caret = (pos: number, to = pos): Selected => [{ from: pos, to }]

const STAND_IN: Record<string, (r: WriteRange) => string> = {
  bullet: (r) => (r.kind === 'bullet' ? `{bullet${r.depth}}` : ''),
  task: (r) => (r.kind === 'task' ? (r.done ? '{done}' : '{todo}') : ''),
  alert: (r) => (r.kind === 'alert' ? `{${r.alert}}` : ''),
  noteTitle: (r) => (r.kind === 'noteTitle' ? `{note ${r.id}}` : ''),
  codeLanguage: (r) => (r.kind === 'codeLanguage' ? `{lang ${r.label}}` : ''),
  footnote: (r) => (r.kind === 'footnote' ? `{^${r.number}${r.definition ? ':' : ''}}` : ''),
  inline: (r) => (r.kind === 'inline' ? `{${r.source}}` : ''),
}

/** The note as Write mode shows it: hidden marks gone, widgets as `{…}`. */
function shown(doc: string, selected: Selected = []): string {
  const replaced = rangesOf(doc, selected)
    .ranges.filter((r) => r.kind !== 'mark' && r.kind !== 'line' && r.kind !== 'unit')
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

const units = (doc: string) =>
  rangesOf(doc)
    .ranges.filter((r) => r.kind === 'unit')
    .map((r) => doc.slice(r.from, r.to))

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
    expect(shown('a ==lit== b')).toBe('a lit b')
  })

  it('of a highlight, its text on the mark fill', () => {
    expect(marks('a ==lit **up**== b')).toEqual([])
    expect(shown('a ==lit **up**== b')).toBe('a lit up b')
    expect(shown('a == b == c, x===y===z')).toBe('a == b == c, x===y===z')
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

  it('in double brackets stay plain text with their brackets, as the preview shows them', () => {
    expect(shown('a wiki link [[QA Write mode]].')).toBe('a wiki link [[QA Write mode]].')
    expect(marks('see [[Plan]]')).toEqual(['cm-wm-plain [Plan]'])
    expect(shown('see [[Plan]]', caret(6))).toBe('see [[Plan]]')
  })

  it('by reference with no definition stay plain text, with the caret beside them or not', () => {
    expect(marks('a [b] c')).toEqual(['cm-wm-plain [b]'])
    expect(rangesOf('a [b] c', caret(2)).ranges).toContainEqual({
      kind: 'mark',
      from: 2,
      to: 5,
      className: 'cm-wm-plain',
    })
    expect(marks('a [b][] c')).toEqual(['cm-wm-plain [b][]'])
    expect(marks('a [b][nope] c')).toEqual(['cm-wm-plain [b][nope]'])
    expect(shown('a [b][nope] c')).toBe('a [b][nope] c')
    expect(marks('keys \u2318[ and \u2318].')).toEqual(['cm-wm-plain [ and \u2318]'])
    expect(shown('a [**b**] c')).toBe('a [b] c')
    expect(marks('[Note]: remember to call\n\nsee [note] here')).toEqual([
      'cm-wm-plain [Note]',
      'cm-wm-plain [note]',
    ])
    expect(marks('a [foo\u00a0bar] c\n\n[foo bar]: /u')).toEqual(['cm-wm-plain [foo\u00a0bar]'])
  })

  it('by reference with a definition are links, whatever the case and spacing of the label', () => {
    expect(marks('a [b] c\n\n[b]: https://example.com')).toEqual([])
    expect(marks('a [B  c][]\n\n[b c]: https://example.com')).toEqual([])
    expect(marks('a [x][B]\n\n[b]: https://example.com')).toEqual([])
    expect(marks('a [b] c\n\n```\n[b]: https://example.com\n```')).toEqual([
      'cm-wm-plain [b]',
      'cm-wm-fence ```',
      'cm-wm-fence ```',
    ])
    expect(marks('[\u1e9e]\n\n[SS]: /u')).toEqual([])
    expect(marks('[\u03c3]\n\n[\u03c2]: /u')).toEqual([])
    expect(marks('[\u00a0]\n\n[\u00a0]: /u')).toEqual([])
  })

  it('inline with no address are links, with the caret in them or not', () => {
    expect(marks('a [x]() c')).toEqual([])
    expect(marks('a []() c')).toEqual([])
    expect(rangesOf('a [x]() c', caret(6)).ranges.filter((r) => r.kind === 'mark')).toEqual([])
  })

  it('leave images to the image rules', () => {
    expect(shown('![alt](a.png)')).toBe('![alt](a.png)')
  })
})

describe('Write mode footnotes', () => {
  const doc = 'One[^a] two[^1] again[^a] none[^x].\n\n[^1]: First.\n[^a]: The **note**.'

  it('show a reference as its number, counted as the preview counts them', () => {
    expect(shown(doc).split('\n')[0]).toBe('One{^1} two{^2} again{^1} none[^x].')
  })

  it('show a definition with its number, then its text', () => {
    expect(shown(doc).split('\n').slice(2)).toEqual(['{^2:}First.', '{^1:}The note.'])
  })

  it('show the source of the one the selection meets', () => {
    expect(shown(doc, caret(4)).split('\n')[0]).toBe('One[^a] two{^2} again{^1} none[^x].')
    const definition = doc.indexOf('[^1]:') + 2
    expect(shown(doc, caret(definition)).split('\n').slice(2)).toEqual([
      '[^1]: First.',
      '{^1:}The note.',
    ])
  })

  it('count as the preview does: escapes and indented code left out, references in definitions last', () => {
    expect(shown('\\[^a] and x[^b] then y[^a]\n\n[^a]: A\n[^b]: B').split('\n')[0]).toBe(
      '[^a] and x{^1} then y{^2}',
    )
    expect(
      shown('Main[^a] then [^c]\n\n[^a]: includes [^b]\n[^b]: B\n[^c]: C').split('\n')[2],
    ).toBe('{^1:}includes {^3}')
    expect(shown('Text\n\n    x[^a]\n\ny[^a]\n\n[^a]: A').split('\n')[4]).toBe('y{^1}')
  })

  it('read a definition inside a quote or a list, and a reference followed by a colon', () => {
    expect(shown('> x[^a]\n>\n> [^a]: note')).toBe('x{^1}\n\n{^1:}note')
    expect(shown('- x[^a]\n- [^a]: note')).toBe('{bullet1} x{^1}\n{bullet1} {^1:}note')
    expect(shown('x[^a]: suffix and y[^a]\n\n[^a]: note').split('\n')[0]).toBe(
      'x{^1}: suffix and y{^1}',
    )
  })

  it('number a reference on a line that only looks like a link definition', () => {
    expect(shown('[TODO]: see this[^1]\n\n[^1]: The note.')).toBe(
      '[TODO]: see this{^1}\n\n{^1:}The note.',
    )
  })

  it('leave a footnote in code, and a definition nothing refers to, as typed', () => {
    expect(shown('`a[^1]`\n\n```\nb[^1]\n```\n\n[^1]: x')).toBe(
      'a[^1]\n\n```\nb[^1]\n```\n\n[^1]: x',
    )
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

  it("draw the label of each of the Markdown example note's five alerts", () => {
    const alerts = rangesOf(example).ranges.flatMap((r) => (r.kind === 'alert' ? [r.alert] : []))
    expect(alerts).toEqual(['note', 'tip', 'important', 'warning', 'caution'])
    const important = example.indexOf('> [!IMPORTANT]')
    const onIt = rangesOf(example, caret(important + 4)).ranges.filter((r) => r.kind === 'alert')
    expect(onIt.map((r) => r.kind === 'alert' && r.alert)).toEqual([
      'note',
      'tip',
      'warning',
      'caution',
    ])
  })
})

describe('Write mode emoji and inline HTML', () => {
  it('draw an emoji shortcode and a kbd, sup or sub element in place of its source', () => {
    expect(shown('Party :tada: now: <kbd>Cmd</kbd> N, x<sup>2</sup> and H<sub>2</sub>O')).toBe(
      'Party {:tada:} now: {<kbd>Cmd</kbd>} N, x{<sup>2</sup>} and H{<sub>2</sub>}O',
    )
    expect(shown('<KBD class="k">A</KBD>')).toBe('{<KBD class="k">A</KBD>}')
  })

  it("show one element's source while the caret is in it or at its edge, the others drawn", () => {
    const doc = ':tada: and <kbd>A</kbd>'
    expect(shown(doc, caret(0))).toBe(':tada: and {<kbd>A</kbd>}')
    expect(shown(doc, caret(6))).toBe(':tada: and {<kbd>A</kbd>}')
    expect(shown(doc, caret(7))).toBe('{:tada:} and {<kbd>A</kbd>}')
    expect(shown(doc, caret(doc.length))).toBe('{:tada:} and <kbd>A</kbd>')
  })

  it('take an element whole, nested tags of its kind counted, and nothing inside it apart', () => {
    expect(shown('<kbd>:tada:</kbd> <sup>**b**</sup>')).toBe(
      '{<kbd>:tada:</kbd>} {<sup>**b**</sup>}',
    )
    expect(shown('<kbd>:tada:</kbd>', caret(0))).toBe('<kbd>:tada:</kbd>')
    expect(shown('<sup>**b**</sup>', caret(0))).toBe('<sup>**b**</sup>')
  })

  it('leave an element holding other HTML or an image as source, whole', () => {
    for (const doc of [
      '<kbd><kbd>Ctrl</kbd>+<kbd>C</kbd></kbd> and :tada:',
      '<sup><img src="https://example.com/a.png"></sup> and :tada:',
      '<sup>![a](https://example.com/a.png)</sup> and :tada:',
    ])
      expect(shown(doc)).toBe(doc.replace(':tada:', '{:tada:}'))
  })

  it('leave other HTML, a tag never closed and a shortcode in code as source', () => {
    expect(shown('<span>a</span> <kbd>b and `:tada:`')).toBe('<span>a</span> <kbd>b and :tada:')
  })
})

describe('Write mode inline math', () => {
  it('draws a formula in place of its source, nothing inside it read as Markdown', () => {
    expect(shown('Top $a_8^2 + b^2 = c^2$ end, $$x*y*z$$')).toBe(
      'Top {$a_8^2 + b^2 = c^2$} end, {$$x*y*z$$}',
    )
  })

  it("shows a formula's source while the caret is in it or at its edge", () => {
    const doc = '$x$ and $y$'
    expect(shown(doc, caret(0))).toBe('$x$ and {$y$}')
    expect(shown(doc, caret(3))).toBe('$x$ and {$y$}')
    expect(shown(doc, caret(4))).toBe('{$x$} and {$y$}')
    expect(shown(doc, caret(doc.length - 1))).toBe('{$x$} and $y$')
  })

  it('leaves dollars the preview shows as text, and a formula over lines, as source', () => {
    for (const doc of ['$5 and $6', 'A $ $ b', '$x\ny$']) expect(shown(doc)).toBe(doc)
    expect(shown('`$x$`')).toBe('$x$')
    expect(shown('$ x $')).toBe('{$ x $}')
  })

  it('draws a formula exactly where the preview draws one', () => {
    const preview = unified().use(remarkParse).use(remarkMath)
    const previewDraws = (doc: string) => {
      const found: string[] = []
      const walk = (node: MdastNode) => {
        if (node.type === 'inlineMath' && node.position && isInlineTex(node.value))
          found.push(doc.slice(node.position.start.offset, node.position.end.offset))
        for (const child of 'children' in node ? node.children : []) walk(child)
      }
      walk(preview.parse(doc))
      return found
    }
    const writeDraws = (doc: string) =>
      rangesOf(doc)
        .ranges.filter((r) => r.kind === 'inline')
        .map((r) => doc.slice(r.from, r.to))
    for (const doc of [
      '$5 and $6',
      'A $ $ b',
      '$ x $',
      '$  x $',
      '$ x  $',
      '$x$ and $ y$',
      'so $$ a $$ end',
      '$  $',
      'cost $5$ and $$\\sum$$',
    ])
      expect({ doc, drawn: writeDraws(doc) }).toEqual({ doc, drawn: previewDraws(doc) })
  })
})

describe('Write mode lists and tasks', () => {
  it('show a bullet for a bullet list mark, by depth, and keep numbers', () => {
    expect(shown('- a\n  * b\n    + c')).toBe('{bullet1} a\n  {bullet2} b\n    {bullet3} c')
    expect(shown('1. one\n2. two')).toBe('1. one\n2. two')
  })

  it('show a checkbox in place of a task box, its list mark and the space after', () => {
    expect(shown('- [ ] open\n- [x] done\n- [X] also')).toBe('{todo}open\n{done}done\n{done}also')
    expect(shown('1. [ ] first')).toBe('1. {todo}first')
    expect(shown('- [ ]\ttabbed\n  - [x] nested')).toBe('{todo}tabbed\n  {done}nested')
  })

  it('give a checked and an open task the same stand-in, so their text starts at one x', () => {
    const { ranges } = rangesOf('- [x] done\n- [ ] open')
    const tasks = ranges.filter((r) => r.kind === 'task')
    expect(tasks.map((r) => [r.to - r.from, r.kind === 'task' && r.box - r.from])).toEqual([
      [6, 2],
      [6, 2],
    ])
  })

  it('in a quote hide the quote mark too', () => {
    expect(shown('> - item')).toBe('{bullet1} item')
  })

  it('let the caret pass a list mark and its space as one unit', () => {
    expect(units('- a\n\n10. b\n\n- [ ] c')).toEqual(['- ', '10. '])
  })
})

describe('Write mode rules', () => {
  it('draw a horizontal rule as a line', () => {
    expect(shown('a\n\n---\n\nb')).toBe('a\n\n\n\nb')
    expect(marks('a\n\n***\n\nb')).toEqual(['cm-wm-rule '])
  })

  it("make a code block's fences transparent, keeping their text and lines, and name its language", () => {
    const doc = 'a\n\n```ts\nconst a = `x` * 2 // **no**\n```\n\nb'
    expect(shown(doc)).toBe('a\n\n```ts{lang TypeScript}\nconst a = `x` * 2 // **no**\n```\n\nb')
    expect(marks(doc)).toEqual(['cm-wm-fence ```ts', 'cm-wm-fence ```'])
    expect(marks('~~~~\ncode\n~~~~')).toEqual(['cm-wm-fence ~~~~', 'cm-wm-fence ~~~~'])
    expect(shown('```made-up title="x"\nx\n```')).toBe('```made-up title="x"{lang made-up}\nx\n```')
    expect(marks('```\nnot closed')).toEqual(['cm-wm-fence ```'])
  })

  it('show the fences of the code block the selection is in', () => {
    const doc = 'a\n\n```ts\ncode\n```\n\nb'
    for (const at of [doc.indexOf('code'), doc.indexOf('```')])
      expect(rangesOf(doc, caret(at)).ranges.filter((r) => r.kind !== 'unit')).toEqual([])
    expect(marks(doc)).toHaveLength(2)
  })

  it('draw only the fences in the range asked for', () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const doc = `\`\`\`ts\n${body}\n\`\`\``
    const state = EditorState.create({ doc, extensions: [noteMarkdown] })
    const tree = ensureSyntaxTree(state, doc.length, 1e9)
    if (!tree) throw new Error('E_TEST_NO_TREE')
    const middle = doc.indexOf('line 25')
    expect(writeRanges(state, tree, [], middle, middle + 7)).toEqual([])
    expect(writeRanges(state, tree, [], 0, 5).map((r) => r.kind)).toEqual(['mark', 'codeLanguage'])
  })

  it('leave indented code, HTML blocks and front matter as source', () => {
    const blocks = ['    indented **code**', '<div>\n**raw**\n</div>', '---\ntitle: **x**\n---']
    for (const doc of blocks) expect(shown(doc)).toBe(doc)
  })

  it("style a table cell's text as a paragraph's", () => {
    expect(shown('| **a** | b \\| c |\n| - | - |\n| `c` | d |')).toBe(
      '| a | b | c |\n| - | - |\n| c | d |',
    )
  })
})

describe('the elements the selection meets', () => {
  it('show the marks of a span the caret is in or touches, and only of that span', () => {
    const doc = 'a **bold** and *it* b'
    expect(shown(doc, caret(5))).toBe('a **bold** and it b')
    expect(shown(doc, caret(2))).toBe('a **bold** and it b')
    expect(shown(doc, caret(10))).toBe('a **bold** and it b')
    expect(shown(doc, caret(11))).toBe('a bold and it b')
    expect(shown(doc, caret(16))).toBe('a bold and *it* b')
    expect(shown('run `npm i` and ~~x~~ <mark>y</mark>', caret(28))).toBe(
      'run npm i and x <mark>y</mark>',
    )
    expect(shown('2 \\* 3', caret(2))).toBe('2 \\* 3')
  })

  it('show the whole source of a link the caret is in, the rest of the line styled', () => {
    const doc = 'see [the docs](https://example.com) and **b**'
    expect(shown(doc, caret(8))).toBe('see [the docs](https://example.com) and b')
    expect(shown(doc, caret(30))).toBe('see [the docs](https://example.com) and b')
    expect(shown(`see [](devot://note/${NOTE}).`, caret(4))).toBe(`see [](devot://note/${NOTE}).`)
    expect(shown('a <https://example.com> b', caret(5))).toBe('a <https://example.com> b')
    const styledText = '[**bold** \\* link](https://example.com)'
    expect(shown(styledText, caret(14))).toBe(styledText)
    expect(shown(styledText, caret(25))).toBe(styledText)
  })

  it('show the number signs of a heading while the caret is on its line', () => {
    const doc = '# One **b**\n## Two'
    expect(shown(doc, caret(4))).toBe('# One b\nTwo')
    expect(shown(doc, caret(8))).toBe('# One **b**\nTwo')
    expect(shown('Title\n=====', caret(1))).toBe('Title\n=====')
    expect(shown('  # Indented', caret(0))).toBe('  # Indented')
  })

  it('keep a list mark, a task box and a quote mark drawn on the caret line', () => {
    expect(shown('- a\n- b', caret(2))).toBe('{bullet1} a\n{bullet1} b')
    expect(shown('- [ ] open', caret(8))).toBe('{todo}open')
    expect(shown('> quote', caret(3))).toBe('quote')
  })

  it('show an alert label while the caret is on its line', () => {
    expect(shown('> [!NOTE]\n> Body', caret(0))).toBe('[!NOTE]\nBody')
    expect(shown('> [!NOTE]\n> Body', caret(12))).toBe('{note}\nBody')
  })

  it('show a horizontal rule as source while the caret is on it', () => {
    expect(shown('a\n\n---\n\nb', caret(4))).toBe('a\n\n---\n\nb')
    expect(shown('a\n\n  ---\n\nb', caret(3))).toBe('a\n\n  ---\n\nb')
    expect(rangesOf('a\n\n---\n\nb', caret(4)).ranges.some((r) => r.kind === 'line')).toBe(false)
  })

  it('show every element a selection meets', () => {
    expect(shown('**a** *b* **c**', caret(0, 7))).toBe('**a** *b* c')
    expect(shown('**one\ntwo**', caret(1))).toBe('**one\ntwo**')
  })
})

describe('the selected ranges', () => {
  const selectionOf = (doc: string, ranges: [number, number][]) =>
    EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h))),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    })

  it('are in order and apart, with each caret of several', () => {
    const state = selectionOf('a\nb\nc\nd\ne\nf', [
      [10, 10],
      [0, 2],
      [2, 3],
    ])
    expect(selectedRanges(state, true)).toEqual([
      { from: 0, to: 3 },
      { from: 10, to: 10 },
    ])
  })

  it('leave out a caret while the editor has no keyboard, never a selection', () => {
    const state = selectionOf('**a**\n**b**', [
      [1, 1],
      [6, 9],
    ])
    expect(selectedRanges(state, false)).toEqual([{ from: 6, to: 9 }])
  })

  it('meet an element at its edges', () => {
    const selected = [
      { from: 4, to: 4 },
      { from: 10, to: 12 },
    ]
    expect(
      [
        [0, 3],
        [0, 4],
        [4, 6],
        [5, 9],
        [12, 20],
        [13, 20],
      ].map(([a, b]) => touches(selected, a as number, b as number)),
    ).toEqual([false, true, true, false, true, false])
  })

  it('give the lines block rules reveal by', () => {
    const state = selectionOf('a\nb\nc\nd\ne\nf', [
      [10, 10],
      [0, 0],
      [2, 2],
    ])
    expect(revealedLines(state, true)).toEqual([
      { first: 1, last: 2 },
      { first: 6, last: 6 },
    ])
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
})

describe('Write mode ranges and rendered blocks', () => {
  it('leave the source of a formula, a diagram and an image as written', () => {
    const doc =
      '$$\n\\{ a_b *c* \\}\n$$\n\n```mermaid\nA-->B\n```\n\n![*x*](https://e.com/a.png)\n\n\\*d\\*'
    expect(shown(doc)).toBe(doc.replace('\\*d\\*', '*d*'))
  })

  it('leave a formula as written when it starts inside a paragraph', () => {
    const doc = '**Before**\n$$\n\\{ *c* \\}\n$$'
    expect(shown(doc)).toBe(doc.replace('**Before**', 'Before'))
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
    // The block field reads the rendered blocks once per change, before the marks are drawn.
    writeBlocksOf(state, tree)
    const started = performance.now()
    const ranges = writeRanges(state, tree, [], from, to)
    expectWithinBudget(context, performance.now() - started, 8)
    expect(ranges.length).toBeGreaterThan(20)
    expect(ranges.every((r) => r.to >= from - block.length && r.from <= to + block.length)).toBe(
      true,
    )
  })

  it('are read near the shown part inside one long span', (context) => {
    const doc = `**${'word *it* '.repeat(50_000)}end**`
    const state = EditorState.create({ doc, extensions: [noteMarkdown] })
    const tree = ensureSyntaxTree(state, doc.length, 1e9)
    if (!tree) throw new Error('E_TEST_NO_TREE')
    const from = Math.floor(doc.length / 2)
    const to = from + 2_000
    const outer = tree.resolveInner(from, 1)
    expect([outer.name, outer.parent?.name]).toContain('StrongEmphasis')
    const started = performance.now()
    const ranges = writeRanges(state, tree, [], from, to)
    expectWithinBudget(context, performance.now() - started, 8)
    expect(ranges.length).toBeGreaterThan(20)
    expect(ranges.every((r) => r.to >= from && r.from <= to)).toBe(true)
  })
})
