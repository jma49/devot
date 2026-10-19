import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { overwrite, overwriteMode, overwriteSpec, toggleOverwrite } from './overwrite'

// `|` marks each caret, `«` and `»` a selection.
function state(marked: string, on = true): EditorState {
  const ranges = []
  let doc = ''
  let start = -1
  for (const ch of marked) {
    if (ch === '«') start = doc.length
    else if (ch === '»') ranges.push(EditorSelection.range(start, doc.length))
    else if (ch === '|') ranges.push(EditorSelection.cursor(doc.length))
    else doc += ch
  }
  let s = EditorState.create({
    doc,
    selection: EditorSelection.create(ranges),
    extensions: [EditorState.allowMultipleSelections.of(true), overwrite()],
  })
  if (on) s = toggled(s)
  return s
}

function toggled(s: EditorState): EditorState {
  let now = s
  const view = {
    get state() {
      return now
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      now = now.update(spec).state
    },
  } as unknown as EditorView
  toggleOverwrite(view)
  return now
}

function show(s: EditorState): string {
  let text = s.doc.toString()
  for (const r of [...s.selection.ranges].reverse())
    text = `${text.slice(0, r.head)}|${text.slice(r.head)}`
  return text
}

function type(marked: string, text: string, on = true): string | null {
  const s = state(marked, on)
  const spec = overwriteSpec(s, text)
  return spec ? show(s.update(spec).state) : null
}

describe('overwrite mode', () => {
  it('is off at first and toggles', () => {
    const s = state('a|b', false)
    expect(s.field(overwriteMode)).toBe(false)
    expect(toggled(s).field(overwriteMode)).toBe(true)
    expect(toggled(toggled(s)).field(overwriteMode)).toBe(false)
  })

  it('replaces the characters after the caret, as many as are typed', () => {
    expect(type('a|bcd', 'x')).toBe('ax|cd')
    expect(type('a|bcd', 'xy')).toBe('axy|d')
  })

  it('inserts at the end of a line and never takes the line break', () => {
    expect(type('ab|\ncd', 'x')).toBe('abx|\ncd')
    expect(type('a|b\ncd', 'xyz')).toBe('axyz|\ncd')
  })

  it('types over the text after each caret', () => {
    expect(type('|ab\n|cd', 'x')).toBe('x|b\nx|d')
  })

  it('takes a whole character made of several code units', () => {
    expect(type('a|\u{1F600}b', 'x')).toBe('ax|b')
  })

  it('counts typed characters as they are seen', () => {
    expect(type('a|bcd', 'e\u0301')).toBe('ae\u0301|cd')
  })

  it('leaves selections, line breaks and an empty text to normal typing', () => {
    expect(type('a«bc»d', 'x')).toBeNull()
    expect(type('a|bc', '\n')).toBeNull()
    expect(type('a|bc', '')).toBeNull()
    expect(type('a|bc', 'x', false)).toBeNull()
  })
})
