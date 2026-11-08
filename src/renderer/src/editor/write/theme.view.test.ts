// @vitest-environment happy-dom
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { beforeAll, describe, expect, it } from 'vitest'
import { noteHighlighting } from '../highlighting'
import { markdownLineStyles } from '../lineStyles'
import { noteHighlightStyle, noteMarkdown } from '../markdown'
import { writeFocusTracking } from './focus'
import { writeMode } from './index'

const COLOURS = {
  'text-editor': 'rgb(1, 1, 1)',
  'syntax-heading': 'rgb(2, 2, 2)',
  'syntax-quote': 'rgb(3, 3, 3)',
  'syntax-link': 'rgb(4, 4, 4)',
}

beforeAll(() => {
  for (const [name, colour] of Object.entries(COLOURS))
    document.documentElement.style.setProperty(`--color-${name}`, colour)
})

function open(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      noteHighlighting(noteHighlightStyle),
      markdownLineStyles,
      writeFocusTracking,
      writeMode(),
      noteMarkdown,
    ],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return new EditorView({ state, parent: document.body })
}

/** How `text` is drawn: its colour and the lines through it, its own and those its boxes pass down. */
function drawnAs(doc: string, text: string): { colour: string; lines: string[] } {
  const editor = open(doc)
  try {
    const span = [...editor.contentDOM.querySelectorAll('span')].find(
      (s) => s.children.length === 0 && s.textContent === text,
    )
    if (!span) throw new Error('E_TEST_NO_SPAN')
    const lines = new Set<string>()
    for (
      let at: Element | null = span;
      at && !at.classList.contains('cm-line');
      at = at.parentElement
    )
      for (const line of getComputedStyle(at).textDecoration.split(' '))
        if (line === 'underline' || line === 'line-through') lines.add(line)
    return { colour: getComputedStyle(span).color, lines: [...lines].sort() }
  } finally {
    editor.destroy()
  }
}

describe('Write mode brackets that are no link', () => {
  it('are drawn as the text around them, without the link colour and underline', () => {
    expect(drawnAs('a [b] c', 'b')).toEqual({ colour: COLOURS['text-editor'], lines: [] })
    expect(drawnAs('see [[Plan]]', 'Plan')).toEqual({ colour: COLOURS['text-editor'], lines: [] })
    expect(drawnAs('# Plan [draft] x', 'draft')).toEqual({
      colour: COLOURS['syntax-heading'],
      lines: [],
    })
    expect(drawnAs('> quote [b] here', 'b')).toEqual({ colour: COLOURS['syntax-quote'], lines: [] })
    expect(drawnAs('> [!NOTE]\n> see [b] here', 'b')).toEqual({
      colour: COLOURS['text-editor'],
      lines: [],
    })
  })

  it('keep the strike of a done task and of strikethrough, and an address its link look', () => {
    expect(drawnAs('- [x] call [Bob] tomorrow', 'Bob').lines).toEqual(['line-through'])
    expect(drawnAs('a [~~gone~~] b', 'gone')).toEqual({
      colour: COLOURS['text-editor'],
      lines: ['line-through'],
    })
    expect(drawnAs('a [see <https://x.com>] b', 'https://x.com')).toEqual({
      colour: COLOURS['syntax-link'],
      lines: ['underline'],
    })
  })
})
