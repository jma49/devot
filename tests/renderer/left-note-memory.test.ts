import { ensureSyntaxTree, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorSelection, EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown, releaseParsedNote } from '../../src/renderer/src/editor/markdown'
import { setWriteFocus, writeFocusTracking, writeMode } from '../../src/renderer/src/editor/write'
import { collected } from '../support/collected'

function shown(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(0),
    extensions: [noteMarkdown, writeFocusTracking, writeMode()],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state.update({ effects: setWriteFocus.of(true) }).state
}

function tableRows(state: EditorState): Decoration[] {
  const rows: Decoration[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    ;(source as DecorationSet).between(0, state.doc.length, (_from, _to, value) => {
      if (String(value.spec['class'] ?? '').includes('cm-wm-row')) rows.push(value)
    })
  }
  return rows
}

const days = [...Array(40).keys()].map((i) => `| Day ${i} | Done ${i} |`)
const TABLE_NOTE = ['# Weeks', '', '| Day | Done |', '| --- | --- |', ...days, ''].join('\n')
const HTML_NOTE =
  '# Keys\n\nPress <kbd>Cmd</kbd> and <mark>this</mark>.\n\n<details>\n\nMore.\n\n</details>\n'
const XML_NOTE = '# Feed\n\n```xml\n<feed><entry id="1">One</entry></feed>\n```\n'
const ANOTHER = '# Another note\n\nPlain text.'

describe('a note the editor left', () => {
  it('is let go by the parser, with its text and what is kept by it', async () => {
    const refs = (() => {
      const state = shown(HTML_NOTE)
      return [new WeakRef(state.doc)]
    })()
    shown(ANOTHER)
    releaseParsedNote()
    expect(await collected(refs)).toBe(true)
  })

  it('is let go by the parser of an XML block in it', async () => {
    await LanguageDescription.matchLanguageName(languages, 'xml')!.load()
    const refs = (() => {
      const state = shown(XML_NOTE)
      return [new WeakRef(state.doc)]
    })()
    shown(ANOTHER)
    releaseParsedNote()
    expect(await collected(refs)).toBe(true)
  })

  it('keeps none of the tables Write mode drew in it', async () => {
    const refs = (() => {
      const drawn = tableRows(shown(TABLE_NOTE))
      expect(drawn.length).toBeGreaterThan(40)
      return drawn.map((row) => new WeakRef(row))
    })()
    shown(ANOTHER)
    releaseParsedNote()
    expect(await collected(refs)).toBe(true)
  })
})
