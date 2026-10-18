import { insertNewline } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import {
  insertLineAbove,
  joinLines,
  linkAt,
  sortLines,
  sortedLines,
  wrapInBackticks,
} from './lineCommands'

/** A state from text with `[` and `]` around the selection (or `^` for a caret). */
function state(marked: string): EditorState {
  const from = marked.includes('[') ? marked.indexOf('[') : marked.indexOf('^')
  const to = marked.includes(']') ? marked.indexOf(']') - 1 : from
  return EditorState.create({
    doc: marked.replace(/[[\]^]/g, ''),
    selection: EditorSelection.range(from, to),
    extensions: [noteMarkdown],
  })
}

/** Runs a command and gives the text after it. */
function run(command: (view: EditorView) => boolean, marked: string): string {
  let now = state(marked)
  const view = {
    get state() {
      return now
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      now = now.update(spec).state
    },
  } as unknown as EditorView
  expect(command(view)).toBe(true)
  const { from, to } = now.selection.main
  const text = now.doc.toString()
  return from === to
    ? `${text.slice(0, from)}^${text.slice(from)}`
    : `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`
}

describe('typing a backtick over a selection', () => {
  it('wraps the selection in backticks', () => {
    const after = wrapInBackticks(state('a [word] b'), '`')
    expect(after).not.toBeNull()
    const next = state('a [word] b').update(after!).state
    expect(next.doc.toString()).toBe('a `word` b')
    expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('word')
  })

  it('leaves a caret and other characters to the editor', () => {
    expect(wrapInBackticks(state('a ^ b'), '`')).toBeNull()
    expect(wrapInBackticks(state('a [word] b'), '*')).toBeNull()
  })
})

describe('Shift+Return', () => {
  it('inserts a plain line, with no list or quote markup', () => {
    const view = {
      state: state('- item^'),
      dispatch(spec: never) {
        view.state = view.state.update(spec).state
      },
    }
    expect(insertNewline(view as unknown as EditorView)).toBe(true)
    expect(view.state.doc.toString()).toBe('- item\n')
    const quote = {
      state: state('> quote^'),
      dispatch(spec: never) {
        quote.state = quote.state.update(spec).state
      },
    }
    insertNewline(quote as unknown as EditorView)
    expect(quote.state.doc.toString()).toBe('> quote\n')
  })
})

describe('sorting lines', () => {
  const lines = ['banana', 'Cherry', 'apple', 'Apple']

  it('ignores case, and keeps equal lines in their order', () => {
    expect(sortedLines(lines, { caseSensitive: false, reverse: false })).toEqual([
      'apple',
      'Apple',
      'banana',
      'Cherry',
    ])
    expect(sortedLines(lines, { caseSensitive: false, reverse: true })).toEqual([
      'Cherry',
      'banana',
      'Apple',
      'apple',
    ])
  })

  it('compares case when asked: capitals first', () => {
    expect(sortedLines(lines, { caseSensitive: true, reverse: false })).toEqual([
      'Apple',
      'Cherry',
      'apple',
      'banana',
    ])
    expect(sortedLines(lines, { caseSensitive: true, reverse: true })).toEqual([
      'banana',
      'apple',
      'Cherry',
      'Apple',
    ])
  })

  it('sorts the selected lines and no others', () => {
    const sort = sortLines({ caseSensitive: false, reverse: false })
    expect(run(sort, 'z\n[c\nB\na]\nA')).toBe('z\n[a\nB\nc]\nA')
    // A selection ending at a line start leaves that line out.
    expect(run(sort, '[c\nb\n]a')).toBe('[b\nc]\na')
  })
})

describe('other line commands', () => {
  it('joins lines with one space, dropping the indent', () => {
    expect(run(joinLines, 'a^\n   b\nc')).toBe('a^ b\nc')
    expect(run(joinLines, '[a\nb\nc]')).toBe('[a b c]')
  })

  it('adds a line above with the same indent', () => {
    expect(run(insertLineAbove, 'a\n  b^')).toBe('a\n  ^\n  b')
  })

  // `|` marks the caret (the brackets are Markdown here).
  const find = (marked: string) => {
    const at = marked.indexOf('|')
    const s = EditorState.create({
      doc: marked.replace('|', ''),
      selection: EditorSelection.cursor(at),
      extensions: [noteMarkdown],
    })
    return linkAt(s, at)
  }

  it('finds the address of the link under the caret', () => {
    const href = (marked: string) => find(marked)?.href
    expect(href('see [te|xt](https://example.com/a) now')).toBe('https://example.com/a')
    expect(href('see [text](https://exam|ple.com/a) now')).toBe('https://example.com/a')
    expect(href('<https://exam|ple.com>')).toBe('https://example.com')
    expect(find('no |link here')).toBeUndefined()
  })

  it('returns the whole link range with its label', () => {
    const doc = 'see [the text](https://example.com/a) now'
    const marked = (at: string) => doc.replace(at, '|' + at)
    const whole = { from: 4, to: 37, text: 'the text', href: 'https://example.com/a' }
    expect(find(marked('the'))).toEqual(whole)
    expect(find(marked('https'))).toEqual(whole)
    expect(find('<https://exam|ple.com> x')).toEqual({
      from: 0,
      to: 21,
      text: 'https://example.com',
      href: 'https://example.com',
    })
    expect(find('[](https://a|.com)')?.text).toBe('https://a.com')
  })
})
