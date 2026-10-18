import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { linkTipAt } from './linkTooltip'
import { noteMarkdown } from './markdown'
import { hideToolbar, setToolbarFocus, toolbarStateExtension } from './toolbarState'

const ID = '0192a6f0-0000-7000-8000-000000000001'

/** `^` marks the caret. */
function at(marked: string, opts: { focused?: boolean; head?: number } = {}) {
  const caret = marked.indexOf('^')
  const doc = marked.replace('^', '')
  let s = EditorState.create({
    doc,
    selection: EditorSelection.cursor(opts.head ?? caret),
    extensions: [noteMarkdown, toolbarStateExtension],
  })
  ensureSyntaxTree(s, s.doc.length, 5000)
  if (opts.focused ?? true) s = s.update({ effects: setToolbarFocus.of(true) }).state
  return s
}

describe('linkTipAt', () => {
  it('shows with the caret in the text or the address of a note link', () => {
    const doc = `see [Plan](devot://note/${ID}) now`
    const note = { from: 4, to: 4 + `[Plan](devot://note/${ID})`.length, note: true, below: false }
    expect(linkTipAt(at(doc.replace('Pl', 'P^l')))).toMatchObject(note)
    expect(linkTipAt(at(doc.replace('devot', 'dev^ot')))).toMatchObject(note)
  })

  it('is Open URL for an https link, an autolink and a bare address', () => {
    expect(linkTipAt(at('a [x](https://exa^mple.com) b'))).toMatchObject({ note: false })
    expect(linkTipAt(at('<https://exa^mple.com>'))).toMatchObject({ note: false })
    expect(linkTipAt(at('go https://exa^mple.com now'))).toMatchObject({ note: false })
  })

  it('is null outside a link and for other addresses', () => {
    expect(linkTipAt(at('no ^link'))).toBeNull()
    expect(linkTipAt(at('[x](http://exa^mple.com)'))).toBeNull()
    expect(linkTipAt(at('[x](mailto:a^@b.c)'))).toBeNull()
    expect(linkTipAt(at('[x](./rela^tive)'))).toBeNull()
  })

  it('is null in an image', () => {
    expect(linkTipAt(at('![alt](https://exa^mple.com/a.png)'))).toBeNull()
  })

  it('is null while a selection is made, the editor has no focus, or it was dismissed', () => {
    const doc = 'a [x](https://example.com) b'
    const base = at(doc, { head: 5 })
    expect(linkTipAt(base)).not.toBeNull()
    expect(linkTipAt(base.update({ selection: EditorSelection.range(3, 6) }).state)).toBeNull()
    expect(linkTipAt(at(doc, { head: 5, focused: false }))).toBeNull()
    expect(linkTipAt(base.update({ effects: hideToolbar.of(null) }).state)).toBeNull()
  })

  it('goes below the line when the caret is in a table row', () => {
    const table = '| a | b |\n|---|---|\n| [x](https://exa^mple.com) | 2 |'
    expect(linkTipAt(at(table))).toMatchObject({ note: false, below: true })
  })
})
