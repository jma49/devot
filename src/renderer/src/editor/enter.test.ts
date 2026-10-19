import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { previewShape } from '../../../../tests/support/preview-html'
import { insertNewlineLeavingMarkup } from './enter'
import { noteMarkdown } from './markdown'

// `^` marks the cursor.
function state(marked: string) {
  const at = marked.indexOf('^')
  return EditorState.create({
    doc: marked.replace('^', ''),
    selection: EditorSelection.cursor(at),
    extensions: [noteMarkdown, history()],
  })
}

const show = (s: EditorState) => {
  const text = s.doc.toString()
  const at = s.selection.main.head
  return `${text.slice(0, at)}^${text.slice(at)}`
}

function enter(marked: string): { text: string; state: EditorState; steps: number } {
  let now = state(marked)
  let steps = 0
  const view = {
    get state() {
      return now
    },
    dispatch: (tr: Transaction) => {
      steps++
      now = tr.state
    },
  } as unknown as EditorView
  expect(insertNewlineLeavingMarkup(view)).toBe(true)
  return { text: show(now), state: now, steps }
}

function typed(marked: string, returns: number, text: string): string {
  let current = marked
  for (let i = 0; i < returns; i++) current = enter(current).text
  const at = current.indexOf('^')
  return current.slice(0, at) + text + current.slice(at + 1)
}

describe('Return on an empty list item', () => {
  it('leaves the list with a blank line, so what follows is a paragraph of its own', async () => {
    expect(enter('- a\n- b\n- ^').text).toBe('- a\n- b\n\n^')
    expect(enter('1. a\n2. b\n3. ^').text).toBe('1. a\n2. b\n\n^')
    expect(enter('- [ ] a\n- [ ] b\n- [ ] ^').text).toBe('- [ ] a\n- [ ] b\n\n^')
    const doc = typed('- a\n- b^', 2, 'Next')
    expect(doc).toBe('- a\n- b\n\nNext')
    // The preview, export and print read it as a paragraph after the list.
    expect(await previewShape(doc)).toBe('<ul><li>a</li><li>b</li></ul><p>Next</p>')
    // Before the fix the text joined the last bullet.
    expect(await previewShape('- a\n- b\nNext')).toBe('<ul><li>a</li><li>bNext</li></ul>')
  })

  it('leaves a list of one item and a loose list the same way', async () => {
    const one = typed('- a^', 2, 'Next')
    expect(one).toBe('- a\n\nNext')
    expect(await previewShape(one)).toBe('<ul><li>a</li></ul><p>Next</p>')
    const two = typed('- a\n- b^', 2, 'Next')
    expect(await previewShape(two)).toBe('<ul><li>a</li><li>b</li></ul><p>Next</p>')
    expect(typed('- a\n\n- b^', 2, 'Next')).toBe('- a\n\n- b\n\nNext')
    expect(await previewShape(typed('- a\n\n- b^', 2, 'Next'))).toBe(
      '<ul><li><p>a</p></li><li><p>b</p></li></ul><p>Next</p>',
    )
  })

  it('adds no blank line where there is one, or no line above', () => {
    expect(enter('- a\n\n- ^').text).toBe('- a\n\n^')
    expect(enter('- ^').text).toBe('^')
    expect(enter('text\n\n- ^').text).toBe('text\n\n^')
  })

  it('goes out one level of a nested list, and keeps a quote around it', () => {
    expect(enter('- a\n  - b\n  - ^').text).toBe('- a\n  - b\n- ^')
    expect(enter('> - a\n> - b\n> - ^').text).toBe('> - a\n> - b\n>\n> ^')
  })

  it('keeps the numbering of an ordered list in sync', () => {
    expect(enter('1. a\n2. b\n3. ^').text).toBe('1. a\n2. b\n\n^')
    expect(enter('1. a\n   1. b\n   2. ^\n2. c').text).toBe('1. a\n   1. b\n2. ^\n3. c')
  })

  it('is one transaction, one undo step', () => {
    const { state: after, steps } = enter('- a\n- b\n- ^')
    expect(steps).toBe(1)
    let undone = after
    undo({ state: after, dispatch: (tr) => (undone = tr.state) })
    expect(undone.doc.toString()).toBe('- a\n- b\n- ')
  })

  it('still continues a list on a line with text', () => {
    expect(enter('- a^').text).toBe('- a\n- ^')
    expect(enter('1. a^').text).toBe('1. a\n2. ^')
    expect(enter('- [ ] a^').text).toBe('- [ ] a\n- [ ] ^')
  })

  it('does nothing outside Markdown lists and quotes', () => {
    const plain = state('text^')
    expect(
      insertNewlineLeavingMarkup({ state: plain, dispatch: () => {} } as unknown as EditorView),
    ).toBe(false)
  })
})

describe('Return on an empty quote line', () => {
  it('continues the quote with a new line of it', () => {
    expect(enter('> a\n> ^').text).toBe('> a\n>\n> ^')
    expect(enter('> ^').text).toBe('>\n> ^')
    expect(enter('> [!NOTE]\n> text\n> ^').text).toBe('> [!NOTE]\n> text\n>\n> ^')
    expect(enter('> > a\n> > ^').text).toBe('> > a\n> >\n> > ^')
    expect(enter('- > a\n  > ^').text).toBe('- > a\n  >\n  > ^')
  })

  it('is one transaction, one undo step', () => {
    const { state: after, steps } = enter('> a\n> ^')
    expect(steps).toBe(1)
    let undone = after
    undo({ state: after, dispatch: (tr) => (undone = tr.state) })
    expect(undone.doc.toString()).toBe('> a\n> ')
  })

  it('only acts at the end of a line with nothing after the marker', () => {
    expect(enter('> a\n> ^b').text).toBe('> a\n>\n> ^b')
    const code = state('```\n> ^\n```')
    expect(
      insertNewlineLeavingMarkup({ state: code, dispatch: () => {} } as unknown as EditorView),
    ).toBe(false)
  })

  it('continues the quote on an empty line in its middle, so the quote stays whole', async () => {
    expect(enter('> a\n> ^\n> b').text).toBe('> a\n>\n> ^\n> b')
    expect(enter('> a\n>^\n> b').text).toBe('> a\n>\n> ^\n> b')
    const twice = typed('> a\n> ^\n> b', 2, 'c')
    expect(twice).toBe('> a\n>\n>\n> c\n> b')
    expect(await previewShape(twice)).toBe('<blockquote><p>a</p><p>cb</p></blockquote>')
    const alert = typed('> [!NOTE]\n> a\n>^\n> b', 1, 'c')
    expect(alert).toBe('> [!NOTE]\n> a\n>\n> c\n> b')
    expect(await previewShape(alert)).toContain('<p>a</p><p>cb</p></div>')
    expect(enter('> > a\n> > ^\n> > b').text).toBe('> > a\n> >\n> > ^\n> > b')
    expect(enter('- > a\n  > ^\n  > b').text).toBe('- > a\n  >\n  > ^\n  > b')
    expect(enter('> a\n> ^\n\nb').text).toBe('> a\n>\n> ^\n\nb')
  })

  it('keeps a quote whole when the empty line is in a list or code block in it', async () => {
    // The `>` of such a line is in the list item, not right in the quote.
    expect(enter('> - a\n>^\n>   b').text).toBe('> - a\n>\n> ^\n>   b')
    expect(await previewShape(typed('> - a\n>^\n>   b', 1, 'c'))).toBe(
      '<blockquote><ul><li>a</li></ul><p>cb</p></blockquote>',
    )
    const item = typed('> - a\n>   ^\n>   b', 1, 'c')
    expect(item).toBe('> - a\n>\n>   c\n>   b')
    expect(await previewShape(item)).toBe(
      '<blockquote><ul><li><p>a</p><p>cb</p></li></ul></blockquote>',
    )
    const alert = typed('> [!NOTE]\n> - a\n>^\n>   b', 1, 'c')
    expect(alert).toBe('> [!NOTE]\n> - a\n>\n> c\n>   b')
    expect(await previewShape(alert)).toContain('<ul><li>a</li></ul><p>cb</p></div>')
    const code = typed('> ```\n> a\n> ^\n> b\n> ```', 1, 'c')
    expect(code).toBe('> ```\n> a\n>\n> c\n> b\n> ```')
    expect(await previewShape(code)).toBe('<blockquote><pre><code>acb</code></pre></blockquote>')
    expect(enter('> ```\n> a\n> ^').text).toBe('> ```\n> a\n>\n> ^')
  })

  it('continues a quote on a line with text', () => {
    expect(enter('> a^').text).toBe('> a\n> ^')
    expect(enter('> > a^').text).toBe('> > a\n> > ^')
  })
})
