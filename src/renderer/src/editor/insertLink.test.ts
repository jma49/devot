import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import { previewTexts, previewTree } from '../../../../tests/support/preview-html'
import { insertLink, selectionHasLink } from './formats'
import { noteMarkdown } from './markdown'

const state = (doc: string, from: number, to: number) =>
  EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [noteMarkdown, history()],
  })

/** The links the preview makes of `markdown`: each one's address and text. */
async function links(markdown: string): Promise<{ href: unknown; text: string }[]> {
  const found: { href: unknown; text: string }[] = []
  const text = (node: Root | RootContent): string =>
    node.type === 'text' ? node.value : 'children' in node ? node.children.map(text).join('') : ''
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element' && (node as Element).tagName === 'a')
      found.push({ href: (node as Element).properties.href, text: text(node) })
    if ('children' in node) node.children.forEach(walk)
  }
  walk(await previewTree(markdown))
  return found
}

describe('the link dialog result', () => {
  it('replaces the selection with the link in one transaction, the caret after it', () => {
    const s = state('see docs here', 4, 8)
    const tr = s.update(insertLink(s, 'docs', 'https://example.com'))
    expect(tr.newDoc.toString()).toBe('see [docs](https://example.com) here')
    expect(tr.newSelection.main.empty).toBe(true)
    expect(tr.newSelection.main.head).toBe('see [docs](https://example.com)'.length)
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
    expect(s.update(insertLink(s, 'x', 'https://a.test/a)b')).newDoc.toString()).toBe(
      '[x](https://a.test/a%29b)',
    )
  })

  it('encodes whitespace in the address, so the preview reads one link to it', async () => {
    const s = state('word', 0, 4)
    const doc = s.update(insertLink(s, 'word', 'https://example.com/a b\tc')).newDoc.toString()
    expect(doc).toBe('[word](https://example.com/a%20b%09c)')
    expect(await links(doc)).toEqual([{ href: 'https://example.com/a%20b%09c', text: 'word' }])
    const path = s.update(insertLink(s, 'plan', '../Notes/My Plan.md')).newDoc.toString()
    expect(await links(path)).toEqual([{ href: '../Notes/My%20Plan.md', text: 'plan' }])
  })

  it('escapes a trailing backslash and a pipe in the text, leaving code spans as they are', async () => {
    const s = state('x', 0, 1)
    const label = async (text: string) =>
      links(s.update(insertLink(s, text, 'https://u.test')).newDoc.toString())
    expect(await label('back\\')).toEqual([{ href: 'https://u.test', text: 'back\\' }])
    expect(await label('C:\\temp\\')).toEqual([{ href: 'https://u.test', text: 'C:\\temp\\' }])
    expect(await label('even\\\\')).toEqual([{ href: 'https://u.test', text: 'even\\' }])
    expect(await label('x|y')).toEqual([{ href: 'https://u.test', text: 'x|y' }])
    expect(await label('a `[b]|` c')).toEqual([{ href: 'https://u.test', text: 'a [b]| c' }])
  })

  it('keeps a table row whole when the link text has a pipe', async () => {
    const doc = '| a | b |\n| --- | --- |\n|  | c |'
    const cell = doc.lastIndexOf('|  |') + 2
    const s = state(doc, cell, cell)
    const empty = s.update(insertLink(s, '', 'http://x.com/a|b')).newDoc.toString()
    expect(await previewTexts(empty, 'td')).toEqual(['http://x.com/a|b', 'c'])
    const typed = s.update(insertLink(s, 'x|y', 'https://u.test')).newDoc.toString()
    expect(await previewTexts(typed, 'td')).toEqual(['x|y', 'c'])
  })

  it('knows when the selection is already a link (the button removes it instead)', () => {
    expect(selectionHasLink(state('[a](b) c', 1, 2))).toBe(true)
    expect(selectionHasLink(state('[a](b) c', 7, 8))).toBe(false)
  })
})
