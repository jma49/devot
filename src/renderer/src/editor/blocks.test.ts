import { history, undo } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { Parser, type SyntaxNode } from '@lezer/common'
import { describe, expect, it, vi } from 'vitest'
import { expectWithinBudget, skipIfOverloaded } from '../../../../tests/support/budget'
import { previewShape } from '../../../../tests/support/preview-html'
import {
  ALERT_KINDS,
  alertKind,
  blockState,
  indentListItems,
  listBullet,
  toggleAlert,
  toggleCodeBlock,
  toggleList,
  toggleQuote,
  type AlertKind,
  type ListKind,
} from './blocks'
import { FORMAT_COMMANDS, formatState, type FormatId } from './formats'
import { noteMarkdown, noteParser } from './markdown'

// Test documents mark the selection inline: `«` is where a range starts and
// `»` where it ends; `|` is a cursor. Several ranges may appear.
function state(marked: string, extra: Extension = []) {
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
    extensions: [EditorState.allowMultipleSelections.of(true), noteMarkdown, history(), extra],
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
  return s.update(spec ?? {}).state
}

const run = (marked: string, command: (s: EditorState) => TransactionSpec | null) => {
  const s = state(marked)
  return show(apply(s, command(s)))
}
const list = (marked: string, kind: ListKind) => run(marked, (s) => toggleList(s, kind))
const quote = (marked: string) => run(marked, toggleQuote)
const alert = (marked: string, kind: AlertKind) => run(marked, (s) => toggleAlert(s, kind))
const code = (marked: string) => run(marked, toggleCodeBlock)
const strip = (marked: string) => marked.replace(/[«»|]/g, '')

// Every result is checked with the editor's parser (GFM and front matter): its block structure, nested.
const SHOWN = new Set([
  'BulletList',
  'OrderedList',
  'ListItem',
  'Task',
  'Paragraph',
  'Blockquote',
  'FencedCode',
  'Table',
  'ATXHeading1',
])

function outline(doc: string): string {
  const nodes = (node: SyntaxNode): string[] => {
    const inner: string[] = []
    for (let c = node.firstChild; c; c = c.nextSibling) inner.push(...nodes(c))
    if (!SHOWN.has(node.name)) return inner
    return [inner.length ? `${node.name}(${inner.join(' ')})` : node.name]
  }
  return nodes(noteParser.parse(doc).topNode).join(' ')
}

describe('bulleted, numbered and task lists', () => {
  it('make every selected line an item, and toggle off again', () => {
    expect(list('«a\nb»', 'bullet')).toBe('- «a\n- b»')
    expect(list('«- a\n- b»', 'bullet')).toBe('«a\nb»')
    expect(list('«a\nb»', 'numbered')).toBe('1. «a\n2. b»')
    expect(list('«1. a\n2. b»', 'numbered')).toBe('«a\nb»')
    expect(list('«a\nb»', 'task')).toBe('- [ ] «a\n- [ ] b»')
    expect(list('«- [ ] a\n- [x] b»', 'task')).toBe('«a\nb»')
    expect(outline(strip(list('«a\nb»', 'task')))).toBe('BulletList(ListItem(Task) ListItem(Task))')
  })

  it('works on the line of a cursor, an empty line included', () => {
    expect(list('a|', 'bullet')).toBe('- a|')
    expect(list('|a', 'bullet')).toBe('- |a')
    expect(list('|', 'numbered')).toBe('1. |')
    expect(list('- a|', 'bullet')).toBe('a|')
    expect(list('x\n|', 'task')).toBe('x\n- [ ] |')
  })

  it('converts the markers when switching between list kinds', () => {
    expect(list('«- a\n* b»', 'numbered')).toBe('1. «a\n2. b»')
    expect(list('«1. a\n2) b»', 'bullet')).toBe('- «a\n- b»')
    expect(list('«- a\n+ b»', 'task')).toBe('- [ ] «a\n+ [ ] b»')
    expect(list('«- [ ] a\n* [x] b»', 'bullet')).toBe('- «a\n* b»')
    expect(list('«- [ ] a\n1. [x] b»', 'numbered')).toBe('1. «a\n2. b»')
    expect(list('«1. a\n2. b»', 'task')).toBe('- [ ] «a\n- [ ] b»')
  })

  it('gives new items the bullet the settings name, and keeps the bullets items have', () => {
    const star = (marked: string, kind: ListKind) => {
      const s = state(marked, listBullet.of('*'))
      return show(apply(s, toggleList(s, kind)))
    }
    expect(star('«a\nb»', 'bullet')).toBe('* «a\n* b»')
    expect(star('«a\nb»', 'task')).toBe('* [ ] «a\n* [ ] b»')
    expect(star('«1. a\n2. b»', 'bullet')).toBe('* «a\n* b»')
    expect(star('«- a\n- b»', 'task')).toBe('- [ ] «a\n- [ ] b»')
    expect(outline(strip(star('«a\nb»', 'bullet')))).toBe(
      'BulletList(ListItem(Paragraph) ListItem(Paragraph))',
    )
  })

  it('applies to the whole selection when only part of it has the kind', () => {
    expect(list('«- a\nb»', 'bullet')).toBe('«- a\n- b»')
    expect(list('«- a\n1. b»', 'bullet')).toBe('«- a\n- b»')
    expect(list('«1. a\n- b»', 'numbered')).toBe('«1. a\n2. b»')
  })

  it('numbers new items after the list they continue', () => {
    expect(list('3. a\n«- b\n- c»', 'numbered')).toBe('3. a\n4. «b\n5. c»')
    expect(list('«x»\n\n1. a\n2. b', 'numbered')).toBe('1. «x»\n\n2. a\n3. b')
    expect(list('1. a\n«b»', 'numbered')).toBe('1. a\n2. «b»')
  })

  it('renumbers a list right after front matter, which is not Markdown', () => {
    // Read as Markdown, the fence in the front matter would make the rest code.
    const front = '---\nnote: |\n  ```\n---\n'
    expect(list(`${front}«x»\n\n1. a\n2. b`, 'numbered')).toBe(`${front}1. «x»\n\n2. a\n3. b`)
  })

  it('does not renumber lines that a change turns into front matter', () => {
    // Without its task box the last line closes front matter that opens on the first.
    expect(list('---\n\nintro\n\n«- [ ] 3. x\n- [ ] ---»', 'task')).toBe(
      '---\n\nintro\n\n«3. x\n---»',
    )
  })

  it('renumbers the rest of a list when an item leaves it', () => {
    const left = list('1. a\n«2. b»\n3. c', 'numbered')
    expect(left).toBe('1. a\n\n«b»\n\n1. c')
    expect(outline(strip(left))).toBe(
      'OrderedList(ListItem(Paragraph)) Paragraph OrderedList(ListItem(Paragraph))',
    )
    expect(list('1. a\n«2. b»\n3. c', 'bullet')).toBe('1. a\n- «b»\n1. c')
    // Without its first item the list still starts at 1, so it stays a list.
    const rest = list('«1. a»\n2. b\n3. c', 'numbered')
    expect(rest).toBe('«a»\n1. b\n2. c')
    expect(outline(strip(rest))).toBe(
      'Paragraph OrderedList(ListItem(Paragraph) ListItem(Paragraph))',
    )
    expect(list('9. «a»\n10. b\n    c', 'task')).toBe('- [ ] «a»\n1. b\n   c')
  })

  it('keeps the items nested when the marker width changes', () => {
    const nested = '«- a\n  - b\n    - c\n- d»'
    const numbered = list(nested, 'numbered')
    expect(numbered).toBe('1. «a\n   1. b\n      1. c\n2. d»')
    expect(outline(strip(numbered))).toBe(
      'OrderedList(ListItem(Paragraph OrderedList(ListItem(Paragraph OrderedList(ListItem(Paragraph))))) ListItem(Paragraph))',
    )
    expect(list(`«${strip(numbered)}»`, 'bullet')).toBe('- «a\n  - b\n    - c\n- d»')
    expect(list(nested, 'task')).toBe('- [ ] «a\n  - [ ] b\n    - [ ] c\n- [ ] d»')
  })

  it('moves the children of an item whose marker changes, selected or not', () => {
    const doc = list('«- a»\n  - b\n\n  more of a\n- c', 'numbered')
    expect(doc).toBe('1. «a»\n   - b\n\n   more of a\n- c')
    expect(outline(strip(doc))).toBe(
      'OrderedList(ListItem(Paragraph BulletList(ListItem(Paragraph)) Paragraph)) BulletList(ListItem(Paragraph))',
    )
    expect(list('«- a»\n  - b', 'bullet')).toBe('«a»\n- b')
  })

  it('moves children again when renumbering widens a number', () => {
    const items = Array.from({ length: 10 }, (_, i) => `- ${String.fromCharCode(97 + i)}`)
    const doc = list(`«${items.join('\n')}»\n  - child`, 'numbered')
    expect(doc.split('\n').slice(-3)).toEqual(['9. i', '10. j»', '    - child'])
    expect(outline(strip(doc))).toMatch(
      /ListItem\(Paragraph BulletList\(ListItem\(Paragraph\)\)\)\)$/,
    )
  })

  it('keeps list items inside quotes and leaves continuation lines alone', () => {
    expect(list('> «a\n> b»', 'bullet')).toBe('> - «a\n> - b»')
    expect(list('> «- a\n>   - b»', 'numbered')).toBe('> 1. «a\n>    1. b»')
    expect(list('«- a\n  more\n- b»', 'numbered')).toBe('1. «a\n   more\n2. b»')
    expect(list('«1. a\nlazy\n- c»', 'numbered')).toBe('«1. a\n2. lazy\n3. c»')
  })

  it('skips blank lines, code, tables and rules in a multi-line selection', () => {
    expect(list('«a\n\nb»', 'bullet')).toBe('- «a\n\n- b»')
    // Tables have bars, which these test documents read as cursors: no marks here.
    const doc = 'a\n```\n- code\n```\n| x | y |\n| - | - |\n| 1 | 2 |\n\n---\nb'
    const s = EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [noteMarkdown],
    })
    expect(apply(s, toggleList(s, 'bullet')).doc.toString()).toBe(
      '- a\n```\n- code\n```\n| x | y |\n| - | - |\n| 1 | 2 |\n\n---\n- b',
    )
    expect(toggleList(state('```\n«code»\n```'), 'bullet')).toBeNull()
  })

  it('nests a continuation line under its item when it is all that is selected', () => {
    const doc = list('1. a\n   «b»', 'bullet')
    expect(doc).toBe('1. a\n   - «b»')
    expect(outline(strip(doc))).toBe(
      'OrderedList(ListItem(Paragraph BulletList(ListItem(Paragraph))))',
    )
  })

  it('numbers new items with the delimiter of the list they join', () => {
    expect(list('«1) a\n- b»', 'numbered')).toBe('«1) a\n2) b»')
    expect(list('1) a\n«b\nc»', 'numbered')).toBe('1) a\n2) «b\n3) c»')
  })

  it('works on every range of a multiple selection', () => {
    expect(list('a|\nb\nc|', 'bullet')).toBe('- a|\nb\n- c|')
  })

  it('treats a marker as one only where the parser reads an item', () => {
    // `2.` cannot start a list after a paragraph line: it is the paragraph's text, kept (escaped).
    const doc = list('«a\n2. b»', 'numbered')
    expect(doc).toBe('1. «a\n2. 2\\. b»')
    expect(outline(strip(doc))).toBe('OrderedList(ListItem(Paragraph) ListItem(Paragraph))')
  })
})

describe('text that only looks like a list marker', () => {
  // One paragraph in CommonMark: the second line is not an item.
  const wrapped = 'We shipped in\n2020. Then| we grew.'

  it('is kept by the list formats, escaped so it stays text in the item', async () => {
    const numbered = list(wrapped, 'numbered')
    expect(numbered).toBe('We shipped in\n1. 2020\\. Then| we grew.')
    const bullet = list(wrapped, 'bullet')
    expect(bullet).toBe('We shipped in\n- 2020\\. Then| we grew.')
    expect(list(wrapped, 'task')).toBe('We shipped in\n- [ ] 2020. Then| we grew.')
    expect(list('We moved on\n3) Then| we left.', 'bullet')).toBe(
      'We moved on\n- 3\\) Then| we left.',
    )
    expect(list('We moved on\n+|', 'bullet')).toBe('We moved on\n- \\+|')
    expect(list('We moved on\n*|', 'numbered')).toBe('We moved on\n1. \\*|')
    expect(outline(strip(numbered))).toBe('Paragraph OrderedList(ListItem(Paragraph))')
    expect(outline(strip(bullet))).toBe('Paragraph BulletList(ListItem(Paragraph))')
    expect(await previewShape(strip(numbered))).toBe(
      '<p>We shipped in</p><ol><li>2020. Then we grew.</li></ol>',
    )
    expect(await previewShape(strip(bullet))).toBe(
      '<p>We shipped in</p><ul><li>2020. Then we grew.</li></ul>',
    )
  })

  it('does not show as a list in the toolbar', () => {
    const pressed = (marked: string) =>
      Object.entries(blockState(state(marked)))
        .filter(([, on]) => on)
        .map(([id]) => id)
    expect(pressed(wrapped)).toEqual([])
    expect(pressed('We moved on\n3) Then| we left.')).toEqual([])
    expect(pressed('- 2020 real item|')).toEqual(['bulletList'])
    expect(pressed('1. a\n2. b|')).toEqual(['numberedList'])
  })

  it('still converts and removes real items whose text starts like one', () => {
    expect(list('- 2020 was good|', 'bullet')).toBe('2020 was good|')
    expect(list('- 2020 was good|', 'numbered')).toBe('1. 2020 was good|')
    expect(list('«1. a\n2. b»', 'bullet')).toBe('- «a\n- b»')
  })

  it('is escaped when the marker before it is taken off, so it is not renumbered', () => {
    const timeline = list('«- 1999. Born\n- 2020. Moved»', 'bullet')
    expect(timeline).toBe('«1999\\. Born\n2020\\. Moved»')
    expect(outline(strip(timeline))).toBe('Paragraph')
    expect(list('- 2020. A good year|', 'bullet')).toBe('2020\\. A good year|')
    expect(list('- [ ] 2020.|', 'task')).toBe('2020\\.|')
    expect(list('1. 2020. x|', 'numbered')).toBe('2020\\. x|')
    expect(list('- 3)|', 'bullet')).toBe('3\\)|')
  })
})

describe('taking a quote or list off lines after others of the block', () => {
  it('ends the quote before the line, and starts it again after', () => {
    const middle = quote('> a\n> «b»\n> c')
    expect(middle).toBe('> a\n\n«b»\n\n> c')
    expect(outline(strip(middle))).toBe('Blockquote(Paragraph) Paragraph Blockquote(Paragraph)')
    const last = quote('> a\n> «b»')
    expect(last).toBe('> a\n\n«b»')
    expect(outline(strip(last))).toBe('Blockquote(Paragraph) Paragraph')
    expect(blockState(state(last)).quote).toBe(false)
    const lines = quote('> a\n> «b\n> c»')
    expect(lines).toBe('> a\n\n«b\nc»')
    expect(outline(strip(lines))).toBe('Blockquote(Paragraph) Paragraph')
  })

  it('keeps the line in the quotes around the one it leaves', () => {
    const nested = quote('> > a\n> > «b»\n> > c')
    expect(nested).toBe('> > a\n>\n> «b»\n>\n> > c')
    expect(outline(strip(nested))).toBe(
      'Blockquote(Blockquote(Paragraph) Paragraph Blockquote(Paragraph))',
    )
    const inItem = quote('- x\n  > a\n  > «b»')
    expect(inItem).toBe('- x\n  > a\n\n  «b»')
    expect(outline(strip(inItem))).toBe(
      'BulletList(ListItem(Paragraph Blockquote(Paragraph) Paragraph))',
    )
  })

  it('ends the list before the line', () => {
    const bullet = list('- a\n«- b»', 'bullet')
    expect(bullet).toBe('- a\n\n«b»')
    expect(outline(strip(bullet))).toBe('BulletList(ListItem(Paragraph)) Paragraph')
    expect(blockState(state(bullet)).bulletList).toBe(false)
    const task = list('- [ ] a\n«- [ ] b»', 'task')
    expect(task).toBe('- [ ] a\n\n«b»')
    expect(outline(strip(task))).toBe('BulletList(ListItem(Task)) Paragraph')
    const middle = list('- a\n«- b»\n- c', 'bullet')
    expect(middle).toBe('- a\n\n«b»\n\n- c')
    expect(outline(strip(middle))).toBe(
      'BulletList(ListItem(Paragraph)) Paragraph BulletList(ListItem(Paragraph))',
    )
    const nested = list('- x\n  - a\n  - «b»', 'bullet')
    expect(nested).toBe('- x\n  - a\n\n  «b»')
    expect(outline(strip(nested))).toBe(
      'BulletList(ListItem(Paragraph BulletList(ListItem(Paragraph)) Paragraph))',
    )
    const quoted = list('> - a\n> - «b»', 'bullet')
    expect(quoted).toBe('> - a\n>\n> «b»')
    expect(outline(strip(quoted))).toBe('Blockquote(BulletList(ListItem(Paragraph)) Paragraph)')
  })

  it('keeps a first sub-item out of its parent item paragraph', async () => {
    const bullet = list('- a\n  - «b»', 'bullet')
    expect(bullet).toBe('- a\n\n  «b»')
    expect(outline(strip(bullet))).toBe('BulletList(ListItem(Paragraph Paragraph))')
    expect(await previewShape(strip(bullet))).toBe('<ul><li><p>a</p><p>b</p></li></ul>')
    const task = list('- [ ] a\n  - [ ] «b»', 'task')
    expect(task).toBe('- [ ] a\n\n  «b»')
    expect(outline(strip(task))).toBe('BulletList(ListItem(Task Paragraph))')
    const numbered = list('1. a\n   1. «b»', 'numbered')
    expect(numbered).toBe('1. a\n\n   «b»')
    expect(outline(strip(numbered))).toBe('OrderedList(ListItem(Paragraph Paragraph))')
    const quoted = list('> - a\n>   1. «b»', 'numbered')
    expect(quoted).toBe('> - a\n>\n>   «b»')
    expect(outline(strip(quoted))).toBe('Blockquote(BulletList(ListItem(Paragraph Paragraph)))')
    const followed = list('- a\n  - «b»\n- c', 'bullet')
    expect(followed).toBe('- a\n\n  «b»\n- c')
    expect(outline(strip(followed))).toBe(
      'BulletList(ListItem(Paragraph Paragraph) ListItem(Paragraph))',
    )
  })

  it('keeps lines that leave together in one paragraph', () => {
    expect(list('«- a\n- b»', 'bullet')).toBe('«a\nb»')
    expect(list('«- a\n  more\n- b»', 'bullet')).toBe('«a\nmore\nb»')
    expect(quote('«> a\n> b»')).toBe('«a\nb»')
  })
})

describe('quotes', () => {
  it('quote every selected line, and toggle off again', () => {
    expect(quote('«a\nb»')).toBe('> «a\n> b»')
    expect(quote('«> a\n> b»')).toBe('«a\nb»')
    expect(quote('a|')).toBe('> a|')
    expect(quote('|')).toBe('> |')
    expect(quote('> |a')).toBe('|a')
  })

  it('quote the blank lines between selected lines too', () => {
    const doc = quote('«a\n\nb»')
    expect(doc).toBe('> «a\n>\n> b»')
    expect(outline(strip(doc))).toBe('Blockquote(Paragraph Paragraph)')
    expect(quote(doc)).toBe('«a\n\nb»')
  })

  it('quote the unquoted lines of a mixed selection', () => {
    expect(quote('«> a\nb»')).toBe('«> a\n> b»')
  })

  it('keep the lists inside the quote', () => {
    const doc = quote('«- a\n  - b»')
    expect(doc).toBe('> «- a\n>   - b»')
    expect(outline(strip(doc))).toBe(
      'Blockquote(BulletList(ListItem(Paragraph BulletList(ListItem(Paragraph)))))',
    )
  })

  it('quote a list item together with the quote inside it', () => {
    const doc = quote('«- a\n  > b»')
    expect(doc).toBe('> «- a\n>   > b»')
    expect(outline(strip(doc))).toBe(
      'Blockquote(BulletList(ListItem(Paragraph Blockquote(Paragraph))))',
    )
  })

  it('read and remove the quote around a list that continues its items', () => {
    expect(alert('> - «a\n>   b»', 'note')).toBe('> [!NOTE]\n> - «a\n>   b»')
    expect(alert('> [!NOTE]\n> - «a\n>   b»', 'note')).toBe('- «a\n  b»')
    expect(quote('«> - a\n>   b»')).toBe('«- a\n  b»')
    expect(blockState(state('«> - a\n>   b»')).quote).toBe(true)
    expect(quote('> - a\n>   «b»')).toBe('> - a\n>   > «b»')
  })

  it('leave the lines of fenced code inside a quote alone', () => {
    expect(toggleQuote(state('> ```\n> «x»\n> ```'))).toBeNull()
    expect(quote('«> a\n> ```\n> x\n> ```»')).toBe('«a\n> ```\n> x\n> ```»')
  })

  it('quote a list item together with its children', () => {
    const doc = quote('- a|\n  b\n  - c\n- d')
    expect(doc).toBe('> - a|\n>   b\n>   - c\n- d')
    expect(outline(strip(doc))).toBe(
      'Blockquote(BulletList(ListItem(Paragraph BulletList(ListItem(Paragraph))))) BulletList(ListItem(Paragraph))',
    )
  })

  it('take the fenced code of a list item along with it', () => {
    const quoted = quote('- «a»\n\n  ```\n  x\n  ```\n- b')
    expect(quoted).toBe('> - «a»\n>\n>   ```\n>   x\n>   ```\n- b')
    expect(outline(strip(quoted))).toBe(
      'Blockquote(BulletList(ListItem(Paragraph FencedCode))) BulletList(ListItem(Paragraph))',
    )
    expect(blockState(state(quoted)).quote).toBe(true)
    const unquoted = quote('> - «a»\n>\n>   ```\n>   x\n>   ```\n> - b')
    expect(unquoted).toBe('- «a»\n\n  ```\n  x\n  ```\n> - b')
    expect(outline(strip(unquoted))).toBe(
      'BulletList(ListItem(Paragraph FencedCode)) Blockquote(BulletList(ListItem(Paragraph)))',
    )
    const inAlert = alert('- «a»\n  ```\n  x\n  ```', 'note')
    expect(inAlert).toBe('> [!NOTE]\n> - «a»\n>   ```\n>   x\n>   ```')
    expect(outline(strip(inAlert))).toBe(
      'Blockquote(Paragraph BulletList(ListItem(Paragraph FencedCode)))',
    )
    expect(alert(inAlert, 'note')).toBe('- «a»\n  ```\n  x\n  ```')
  })

  it('quote a line inside the list item it continues', () => {
    const cont = quote('- a\n  b|')
    expect(cont).toBe('- a\n  > b|')
    expect(outline(strip(cont))).toBe('BulletList(ListItem(Paragraph Blockquote(Paragraph)))')
    expect(quote(cont)).toBe('- a\n  b|')
    const nested = quote('- a\n  - b|')
    expect(nested).toBe('- a\n  > - b|')
    expect(outline(strip(nested))).toBe(
      'BulletList(ListItem(Paragraph Blockquote(BulletList(ListItem(Paragraph)))))',
    )
    const inAlert = alert('- a\n  b|', 'note')
    expect(inAlert).toBe('- a\n  > [!NOTE]\n  > b|')
    expect(outline(strip(inAlert))).toBe('BulletList(ListItem(Paragraph Blockquote(Paragraph)))')
    expect(alert(inAlert, 'note')).toBe('- a\n  b|')
  })

  it('take a setext heading whole', () => {
    expect(quote('Title|\n---')).toBe('> Title|\n> ---')
    expect(outline(strip(quote('Title|\n---')))).toBe('Blockquote')
    expect(toggleList(state('Title|\n---'), 'bullet')).toBeNull()
  })

  it('turn an alert into a plain quote', () => {
    expect(quote('> [!NOTE]\n> «a»')).toBe('> «a»')
    expect(quote('> [!TIP]\n> a\n> «b»')).toBe('> a\n> «b»')
  })

  it('leave fenced code alone', () => {
    expect(quote('«a\n```\n> x\n```»')).toBe('> «a\n```\n> x\n```»')
    expect(toggleQuote(state('```\n«> x»\n```'))).toBeNull()
  })
})

describe('alerts', () => {
  it('put the selected lines in an alert of the kind picked', () => {
    for (const kind of ALERT_KINDS) {
      const doc = alert('«a\nb»', kind)
      expect(doc).toBe(`> [!${kind.toUpperCase()}]\n> «a\n> b»`)
      expect(outline(strip(doc))).toBe('Blockquote(Paragraph)')
    }
    expect(alert('|', 'note')).toBe('> [!NOTE]\n> |')
  })

  it('turn a quote into an alert, and change the kind of an alert', () => {
    expect(alert('> «a»\n> b', 'tip')).toBe('> [!TIP]\n> «a»\n> b')
    expect(alert('> [!NOTE]\n> «a»', 'warning')).toBe('> [!WARNING]\n> «a»')
  })

  it('remove the whole alert when it already has the kind picked', () => {
    expect(alert('> [!TIP]\n> «a»\n> b', 'tip')).toBe('«a»\nb')
    expect(alert('> [!caution]\n>\n> a|', 'caution')).toBe('\na|')
    expect(alert('> [!NOTE]|', 'note')).toBe('|')
  })

  it('cover the blank lines between selected lines', () => {
    const doc = alert('«a\n\nb»', 'important')
    expect(doc).toBe('> [!IMPORTANT]\n> «a\n>\n> b»')
    expect(outline(strip(doc))).toBe('Blockquote(Paragraph Paragraph)')
  })

  it('take in an alert the new lines join, dropping its alert line', () => {
    const doc = alert('«a\n> [!TIP]\n> b»', 'tip')
    expect(doc).toBe('> [!TIP]\n> «a\n> b»')
    expect(alert('«a»\n\n> [!NOTE]\n> b', 'warning')).toBe('> [!WARNING]\n> «a»\n\n> [!NOTE]\n> b')
  })

  it('keep an alert right below lines that are quoted', () => {
    const doc = quote('«para»\n> [!NOTE]\n> body')
    expect(doc).toBe('> «para»\n\n> [!NOTE]\n> body')
    expect(outline(strip(doc))).toBe('Blockquote(Paragraph) Blockquote(Paragraph)')
    expect(alertKind(state('> para\n\n> [!NOTE]\n> bo|dy'))).toBe('note')
    expect(quote('- x\n  «para»\n  > [!TIP]\n  > body')).toBe(
      '- x\n  > «para»\n\n  > [!TIP]\n  > body',
    )
  })

  it('read the kind of the selection', () => {
    expect(alertKind(state('> [!Warning]\n> «a»'))).toBe('warning')
    expect(alertKind(state('> «a»'))).toBeNull()
    expect(alertKind(state('> [!NOTE]\n> «a\n\n> [!TIP]\n> b»'))).toBeNull()
  })

  it('leave fenced code alone', () => {
    expect(alert('«a\n```\nx\n```»', 'note')).toBe('> [!NOTE]\n> «a\n```\nx\n```»')
  })
})

describe('code blocks', () => {
  it('wrap the selected lines in a fence, and unwrap it again', () => {
    const doc = code('«a\nb»')
    expect(doc).toBe('```\n«a\nb»\n```')
    expect(outline(strip(doc))).toBe('FencedCode')
    expect(code(doc)).toBe('«a\nb»')
  })

  it('unwrap the block a cursor is in, keeping its text', () => {
    expect(code('```js\nco|de\n```')).toBe('co|de')
    expect(code('~~~\nx|\n~~~')).toBe('x|')
    expect(code('```\nco|de')).toBe('co|de')
    expect(code('a\n```\n|\n```\nb')).toBe('a\n|\nb')
  })

  it('open an empty block at a cursor on an empty line', () => {
    expect(code('|')).toBe('```\n|\n```')
    expect(code('a\n|')).toBe('a\n```\n|\n```')
  })

  it('use a fence longer than any inside', () => {
    const doc = code('«a\n```js\nx\n```»')
    expect(doc).toBe('````\n«a\n```js\nx\n```»\n````')
    expect(outline(strip(doc))).toBe('FencedCode')
    expect(code('«a\n`````\nx\n`````»')).toBe('``````\n«a\n`````\nx\n`````»\n``````')
  })

  it('stay inside a quote and come out of a list item whole', () => {
    const quoted = code('> «a»')
    expect(quoted).toBe('> ```\n> «a»\n> ```')
    expect(outline(strip(quoted))).toBe('Blockquote(FencedCode)')
    expect(code(quoted)).toBe('> «a»')
    const inItem = code('- a\n  «b»')
    expect(inItem).toBe('- a\n  ```\n  «b»\n  ```')
    expect(outline(strip(inItem))).toBe('BulletList(ListItem(Paragraph FencedCode))')
    const item = code('- ```\n  co|de\n  ```')
    expect(item).toBe('- co|de')
    expect(outline(strip(item))).toBe('BulletList(ListItem(Paragraph))')
  })

  it('wrap each range of a multiple selection on its own', () => {
    expect(code('a|\nb\nc|')).toBe('```\na|\n```\nb\n```\nc|\n```')
  })

  it('take in the rest of a fenced block the selection ends in', () => {
    const doc = code('«a\n```\nx»\ny\n```\nz')
    expect(doc).toBe('````\n«a\n```\nx»\ny\n```\n````\nz')
    expect(outline(strip(doc))).toBe('FencedCode Paragraph')
  })

  it('take a setext heading whole', () => {
    const text = code('«Title»\n---')
    expect(text).toBe('```\n«Title»\n---\n```')
    expect(outline(strip(text))).toBe('FencedCode')
    expect(code('Title\n«---»')).toBe('```\nTitle\n«---»\n```')
    expect(code('a\n\n«Title»\n===\nb')).toBe('a\n\n```\n«Title»\n===\n```\nb')
  })

  it('turn indented code into a fenced block, keeping its text', () => {
    const top = code('para\n\n    «code»\n      more')
    expect(top).toBe('para\n\n```\n«code»\n  more\n```')
    expect(outline(strip(top))).toBe('Paragraph FencedCode')
    expect(code('«para\n\n    code»')).toBe('```\n«para\n\ncode»\n```')
    const quoted = code('> x\n>\n>     «code»')
    expect(quoted).toBe('> x\n>\n> ```\n> «code»\n> ```')
    expect(outline(strip(quoted))).toBe('Blockquote(Paragraph FencedCode)')
    const inItem = code('- a\n\n      «code»')
    expect(inItem).toBe('- a\n\n  ```\n  «code»\n  ```')
    expect(outline(strip(inItem))).toBe('BulletList(ListItem(Paragraph FencedCode))')
  })

  it('go inside the empty list item they are made in, keeping its marker', () => {
    const numbered = code('1. Run this:\n2. |')
    expect(numbered).toBe('1. Run this:\n2. ```\n   |\n   ```')
    expect(outline(strip(numbered))).toBe('OrderedList(ListItem(Paragraph) ListItem(FencedCode))')
    const bullet = code('- |')
    expect(bullet).toBe('- ```\n  |\n  ```')
    expect(outline(strip(bullet))).toBe('BulletList(ListItem(FencedCode))')
    expect(code('10. a\n11. |')).toBe('10. a\n11. ```\n    |\n    ```')
    const quoted = code('> - |')
    expect(quoted).toBe('> - ```\n>   |\n>   ```')
    expect(outline(strip(quoted))).toBe('Blockquote(BulletList(ListItem(FencedCode)))')
    expect(code('- a\n  - |')).toBe('- a\n  - ```\n    |\n    ```')
    // A marker followed by extra spaces keeps one, so the lines under it stay in the item.
    expect(code('-   |')).toBe('- ```\n  |\n  ```')
    expect(code(bullet)).toBe('- |')
    expect(code(numbered)).toBe('1. Run this:\n2. |')
  })

  it('go under the marker of an empty task item', () => {
    const task = code('- [ ] |')
    expect(task).toBe('- [ ] \n  ```\n  |\n  ```')
    expect(outline(strip(task))).toBe('BulletList(ListItem(Task FencedCode))')
  })

  it('go inside the item an indented blank line continues', () => {
    const after = code('1. Run this:\n   |')
    expect(after).toBe('1. Run this:\n   ```\n   |\n   ```')
    expect(outline(strip(after))).toBe('OrderedList(ListItem(Paragraph FencedCode))')
    expect(code('- a\n\n  |')).toBe('- a\n\n  ```\n  |\n  ```')
    expect(code('- a\n  - b\n    |')).toBe('- a\n  - b\n    ```\n    |\n    ```')
    expect(code('> - a\n>   |')).toBe('> - a\n>   ```\n>   |\n>   ```')
    expect(code('1. a\n\n|')).toBe('1. a\n\n```\n|\n```')
    const quoted = code('> - a\n    |')
    expect(outline(strip(quoted))).toBe('Blockquote(BulletList(ListItem(Paragraph))) FencedCode')
  })

  it('go inside a quote that is inside a list item', () => {
    const quoted = code('- step\n  > «quoted»')
    expect(quoted).toBe('- step\n  > ```\n  > «quoted»\n  > ```')
    expect(outline(strip(quoted))).toBe('BulletList(ListItem(Paragraph Blockquote(FencedCode)))')
    expect(code('1. step\n   > qu|oted')).toBe('1. step\n   > ```\n   > qu|oted\n   > ```')
    expect(code('- [ ] task\n  > «note»')).toBe('- [ ] task\n  > ```\n  > «note»\n  > ```')
    expect(code('- step\n\n  > «quoted»')).toBe('- step\n\n  > ```\n  > «quoted»\n  > ```')
    expect(code('> - step\n>   > «quoted»')).toBe('> - step\n>   > ```\n>   > «quoted»\n>   > ```')
  })

  it('wrap a mixed selection, code included, in one longer fence', () => {
    expect(code('«a\n```\nx\n```\nb»')).toBe('````\n«a\n```\nx\n```\nb»\n````')
  })
})

describe('block formats in the toolbar', () => {
  it('report which block formats the selection has', () => {
    const pressed = (marked: string) =>
      Object.entries(formatState(state(marked)))
        .filter(([, on]) => on)
        .map(([id]) => id)
    expect(pressed('«- a\n- b»')).toEqual(['bulletList'])
    expect(pressed('«1. a\n2. b»')).toEqual(['numberedList'])
    expect(pressed('- [ ] «a»')).toEqual(['taskList'])
    expect(pressed('«- a\n1. b»')).toEqual([])
    expect(pressed('> «a»')).toEqual(['quote'])
    expect(pressed('> [!NOTE]\n> «a»')).toEqual(['alert'])
    expect(pressed('```\n«a»\n```')).toEqual(['codeBlock'])
    expect(pressed('> - «a»')).toEqual(['bulletList', 'quote'])
  })

  it('is the same state blockState reads', () => {
    const s = state('> [!TIP]\n> - [x] «a»')
    expect(blockState(s)).toEqual({
      codeBlock: false,
      bulletList: false,
      numberedList: false,
      taskList: true,
      quote: false,
      alert: true,
    })
  })
})

describe('block format commands', () => {
  const ids: [FormatId, string][] = [
    ['codeBlock', '```\nword\n```'],
    ['bulletList', '- word'],
    ['numberedList', '1. word'],
    ['taskList', '- [ ] word'],
    ['quote', '> word'],
    ['alertNote', '> [!NOTE]\n> word'],
    ['alertTip', '> [!TIP]\n> word'],
    ['alertImportant', '> [!IMPORTANT]\n> word'],
    ['alertWarning', '> [!WARNING]\n> word'],
    ['alertCaution', '> [!CAUTION]\n> word'],
  ]

  it.each(ids)('%s is one transaction and one undo step', (id, formatted) => {
    let s = state('')
    s = s.update({ changes: { from: 0, insert: 'word' }, userEvent: 'input.type' }).state
    s = s.update({ selection: EditorSelection.range(0, 4), userEvent: 'select' }).state
    const tr = s.update(FORMAT_COMMANDS[id](s) ?? {})
    expect(tr.isUserEvent('input.format')).toBe(true)
    expect(tr.state.doc.toString()).toBe(formatted)
    const end = tr.state.selection.main.head
    let after = tr.state.update({
      changes: { from: end, insert: 'x' },
      userEvent: 'input.type',
    }).state
    const steps: string[] = []
    for (let i = 0; i < 3; i++) {
      undo({ state: after, dispatch: (t: Transaction) => (after = t.state) })
      steps.push(after.doc.toString())
    }
    expect(steps).toEqual([formatted, 'word', ''])
  })

  it('renumbering is part of the same step', () => {
    let s = state('«- a\n- b\n- c»')
    s = apply(s, toggleList(s, 'numbered'))
    expect(s.doc.toString()).toBe('1. a\n2. b\n3. c')
    undo({ state: s, dispatch: (t: Transaction) => (s = t.state) })
    expect(s.doc.toString()).toBe('- a\n- b\n- c')
  })
})

describe('large notes', () => {
  const block =
    'Some text with `code` here.\n\n- item one\n  - [ ] task two\n\n```js\nconst a = 1\n```\n\n> a quote\n\n1. first\n2. second\n\n'
  const big = () => {
    let doc = ''
    while (doc.length < 200_000) doc += block
    return EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [noteMarkdown],
    })
  }

  it('formats the top of a very long note without parsing all of it', (context) => {
    let doc = ''
    while (doc.length < 4_000_000) doc += block
    const s = EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [noteMarkdown],
    })
    const start = performance.now()
    const spec = toggleList(s, 'bullet')
    const ms = performance.now() - start
    // A command gives up (null) when its parse budget runs out.
    if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
    expect(spec).not.toBeNull()
    expectWithinBudget(context, ms, 1000)
    expect(apply(s, spec).doc.sliceString(0, 20)).toBe('- Some text with `co')
    // How far the state's parser got: a zero-length request returns its tree as it is.
    expect(ensureSyntaxTree(s, 0, 0)?.length ?? doc.length).toBeLessThan(doc.length / 10)
  })

  const commands: [string, (s: EditorState) => TransactionSpec | null][] = [
    ['numbered list', (s) => toggleList(s, 'numbered')],
    ['bulleted list', (s) => toggleList(s, 'bullet')],
    ['quote', toggleQuote],
    ['alert', (s) => toggleAlert(s, 'note')],
    ['code block', toggleCodeBlock],
  ]

  it('formats a 200 KB selection it has to parse first', { timeout: 30_000 }, (context) => {
    // No time limit here, but the parse itself has a budget.
    for (const [name, command] of commands) {
      const spec = command(big())
      if (spec === null) skipIfOverloaded(context, `${name}: parse budget ran out`)
      expect(spec).not.toBeNull()
    }
  })

  it.for(commands)('formats a parsed 200 KB selection quickly: %s', ([, command], context) => {
    const s = big()
    expect(ensureSyntaxTree(s, s.doc.length, 1e9)).not.toBeNull()
    const start = performance.now()
    const spec = command(s)
    const ms = performance.now() - start
    if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
    expect(spec).not.toBeNull()
    expectWithinBudget(context, ms, 3000)
  })
})

describe('lists at the end of a note', () => {
  it.each<[string, ListKind, string]>([
    ['1. a\n2. b\n\n|', 'numbered', '1. a\n2. b\n\n3. |'],
    ['para\n\n|', 'numbered', 'para\n\n1. |'],
    ['- a\n\n|', 'bullet', '- a\n\n- |'],
    ['---\nx: 1\n---\n\n|', 'numbered', '---\nx: 1\n---\n\n1. |'],
    ['1. a\n2. b\n\n\n|', 'numbered', '1. a\n2. b\n\n\n3. |'],
    ['5. a\n6. b\n|', 'numbered', '5. a\n6. b\n7. |'],
    ['> 1. a\n>\n> |', 'numbered', '> 1. a\n>\n> 2. |'],
  ])('numbers the new item after an empty last line: %j', (marked, kind, expected) => {
    expect(list(marked, kind)).toBe(expected)
  })

  const note = () => {
    let doc = ''
    while (doc.length < 200_000) doc += '1. one\n2. two\n\nA paragraph of **plain** text.\n\n'
    return doc
  }

  // Renumbering reads the stretch of blocks around the new item, never the whole note.
  it.each<ListKind>(['numbered', 'bullet', 'task'])(
    'parses only the end of a 200 KB note for a %s item on its empty last line',
    (kind) => {
      const doc = note()
      const s = state(`${doc}|`)
      expect(ensureSyntaxTree(s, s.doc.length, 30_000)).not.toBeNull()
      const parse = vi.spyOn(Parser.prototype, 'parse')
      try {
        expect(toggleList(s, kind)).not.toBeNull()
        const longest = Math.max(0, ...parse.mock.calls.map(([input]) => String(input).length))
        expect(longest).toBeLessThan(2_000)
      } finally {
        parse.mockRestore()
      }
    },
  )
})

describe('Tab and Shift+Tab on list items', () => {
  const tab = (marked: string, dir: 1 | -1 = 1) => run(marked, (s) => indentListItems(s, dir))

  it('nest a numbered item under the text of the item above, from 1', () => {
    const nested = tab('1. first\n2. chi|ld')
    expect(nested).toBe('1. first\n   1. chi|ld')
    expect(outline(strip(nested))).toBe(
      'OrderedList(ListItem(Paragraph OrderedList(ListItem(Paragraph))))',
    )
    const wide = tab('10. a\n11. b|')
    expect(wide).toBe('10. a\n    1. b|')
    expect(outline(strip(wide))).toBe(
      'OrderedList(ListItem(Paragraph OrderedList(ListItem(Paragraph))))',
    )
    expect(tab('- a\n- b|')).toBe('- a\n  - b|')
    expect(tab('> 1. a\n> 2. b|')).toBe('> 1. a\n>    1. b|')
  })

  it('renumber the list the item leaves and the one it joins', () => {
    expect(tab('1. a\n2. b|\n3. c')).toBe('1. a\n   1. b|\n2. c')
    expect(tab('1. a\n   1. x\n2. b|')).toBe('1. a\n   1. x\n   2. b|')
    expect(tab('1. a\n2. «b\n3. c»')).toBe('1. a\n   1. «b\n   2. c»')
  })

  it('move the item lines with it', () => {
    const moved = tab('1. a\n2. b|\n   - kid')
    expect(moved).toBe('1. a\n   1. b|\n      - kid')
    expect(outline(strip(moved))).toBe(
      'OrderedList(ListItem(Paragraph OrderedList(ListItem(Paragraph BulletList(ListItem(Paragraph))))))',
    )
  })

  it('move an item out to the marker of the item it is in with Shift+Tab', () => {
    expect(tab('1. first\n   1. chi|ld', -1)).toBe('1. first\n2. chi|ld')
    expect(tab('1. a\n   1. b|\n2. c', -1)).toBe('1. a\n2. b|\n3. c')
    expect(tab('- a\n  - b|', -1)).toBe('- a\n- b|')
  })

  it('leave an item that cannot move to the usual indent', () => {
    expect(indentListItems(state('1. a|'), 1)).toBeNull()
    expect(indentListItems(state('- a\n  - b|'), 1)).toBeNull()
    expect(indentListItems(state('1. a\n2. b|'), -1)).toBeNull()
    expect(indentListItems(state('plain|'), 1)).toBeNull()
  })
})
