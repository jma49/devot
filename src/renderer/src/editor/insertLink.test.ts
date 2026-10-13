import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { insertLink, selectionHasLink } from './formats'
import { noteMarkdown } from './markdown'

const state = (doc: string, from: number, to: number) =>
  EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [noteMarkdown, history()],
  })

describe('the link dialog result', () => {
  it('replaces the selection with the link in one transaction, the caret after it', () => {
    const s = state('see docs here', 4, 8)
    const tr = s.update(insertLink(s, 'docs', 'https://example.com'))
    expect(tr.newDoc.toString()).toBe('see [docs](https://example.com) here')
    expect(tr.newSelection.main.empty).toBe(true)
    expect(tr.newSelection.main.head).toBe('see [docs](https://example.com)'.length)
    // One undo step takes it all back.
    let back = tr.state
    undo({ state: back, dispatch: (t) => (back = t.state) })
    expect(back.doc.toString()).toBe('see docs here')
  })

  it('takes the edited text, escapes lone brackets and uses the URL when the text is empty', () => {
    const s = state('x', 0, 1)
    expect(s.update(insertLink(s, 'a [b', ' https://a.test ')).newDoc.toString()).toBe(
      '[a \\[b](https://a.test)',
    )
    expect(s.update(insertLink(s, '  ', 'https://a.test')).newDoc.toString()).toBe(
      '[https://a.test](https://a.test)',
    )
    // An address that would end the link early is encoded.
    expect(s.update(insertLink(s, 'x', 'https://a.test/a)b')).newDoc.toString()).toBe(
      '[x](https://a.test/a%29b)',
    )
  })

  it('knows when the selection is already a link (the button removes it instead)', () => {
    expect(selectionHasLink(state('[a](b) c', 1, 2))).toBe(true)
    expect(selectionHasLink(state('[a](b) c', 7, 8))).toBe(false)
  })
})
