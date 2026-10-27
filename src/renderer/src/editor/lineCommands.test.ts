import { insertNewline } from '@codemirror/commands'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import {
  changeCase,
  insertLineAbove,
  joinLines,
  LINE_COMMANDS,
  linkAt,
  linkOpener,
  lineKeys,
  openLinkAtCaret,
  runEditCommand,
  skipNextOccurrence,
  linkForNewNote,
  sortLines,
  sortedLines,
  splitSelectionIntoLines,
  toggleTaskAtCaret,
  wrapInBackticks,
} from './lineCommands'

function state(marked: string): EditorState {
  const from = marked.includes('[') ? marked.indexOf('[') : marked.indexOf('^')
  const to = marked.includes(']') ? marked.indexOf(']') - 1 : from
  return EditorState.create({
    doc: marked.replace(/[[\]^]/g, ''),
    selection: EditorSelection.range(from, to),
    extensions: [noteMarkdown],
  })
}

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

describe('opening the link at the caret', () => {
  const open = (marked: string) => {
    const opened: string[] = []
    const at = marked.indexOf('^')
    const now = EditorState.create({
      doc: marked.replace('^', ''),
      selection: EditorSelection.cursor(at),
      extensions: [noteMarkdown, linkOpener.of((href) => opened.push(href))],
    })
    const handled = openLinkAtCaret({ state: now } as unknown as EditorView)
    return { handled, opened }
  }

  it('opens a web page or a note', () => {
    expect(open('[x](https://exa^mple.com)')).toEqual({
      handled: true,
      opened: ['https://example.com'],
    })
    const note = 'devot://note/0192a6f0-0000-7000-8000-000000000001'
    expect(open(`[x](${note.replace('note/', 'no^te/')})`)).toEqual({
      handled: true,
      opened: [note],
    })
  })

  it('leaves a link the app does not open to the key’s usual job', () => {
    for (const marked of ['[x](http://exa^mple.com)', '[x](mailto:a^@b.c)', '[x](other.m^d)']) {
      expect(open(marked)).toEqual({ handled: false, opened: [] })
    }
  })
})

describe('linkForNewNote', () => {
  const at = (doc: string, pos: number) =>
    linkForNewNote(EditorState.create({ doc, extensions: [noteMarkdown] }), pos)?.text

  it('finds web links, not image addresses or note links', () => {
    expect(at('See [Foo](https://x.test/a) now', 8)).toBe('Foo')
    expect(at('Go https://x.test/a now', 6)).toBe('https://x.test/a')
    expect(at('![alt](https://x.test/a.png)', 12)).toBeUndefined()
    expect(at('[Foo](devot://note/0194e1e4-7b1c-7000-8000-000000000001)', 3)).toBeUndefined()
  })
})

// Several ranges: `«` starts one and `»` ends it; `|` is a caret.
function multi(marked: string, main?: number): EditorState {
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
    selection: EditorSelection.create(ranges, main ?? ranges.length - 1),
    extensions: [EditorState.allowMultipleSelections.of(true), noteMarkdown],
  })
}

function showMulti(s: EditorState): string {
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

function runMulti(
  command: (view: EditorView) => boolean,
  marked: string,
  main?: number,
): string | null {
  let now = multi(marked, main)
  const view = {
    get state() {
      return now
    },
    dispatch: (spec: Transaction | TransactionSpec) => {
      now = spec instanceof Transaction ? spec.state : now.update(spec).state
    },
  } as unknown as EditorView
  return command(view) ? showMulti(now) : null
}

describe('selection commands', () => {
  it('skips the last selection for the next match of its text', () => {
    expect(runMulti(skipNextOccurrence, '«ab» x ab y ab')).toBe('ab x «ab» y ab')
    expect(runMulti(skipNextOccurrence, '«ab» x «ab» y ab')).toBe('«ab» x ab y «ab»')
    // From the start again past the end, never onto a selected match.
    expect(runMulti(skipNextOccurrence, 'ab x «ab» y «ab»')).toBe('«ab» x «ab» y ab')
    expect(runMulti(skipNextOccurrence, '«ab» abc ab')).toBe('ab abc «ab»')
    expect(runMulti(skipNextOccurrence, '«ab» x')).toBeNull()
  })

  it('skips the most recently added match after Select Next wrapped around', () => {
    // The wrapped match sits first in the document but is the main selection.
    expect(runMulti(skipNextOccurrence, '«ab» x «ab» y ab', 0)).toBe('ab x «ab» y «ab»')
    expect(runMulti(skipNextOccurrence, '«ab» x «ab» y «ab» z ab', 0)).toBe(
      'ab x «ab» y «ab» z «ab»',
    )
  })

  it('selects the word at a caret before skipping', () => {
    expect(runMulti(skipNextOccurrence, 'a|b x ab')).toBe('«ab» x ab')
  })

  it('splits a selection into a range per line', () => {
    expect(runMulti(splitSelectionIntoLines, 'o«ne\ntwo\nth»ree')).toBe('o«ne»\n«two»\n«th»ree')
    expect(runMulti(splitSelectionIntoLines, '«one\ntwo\n»three')).toBe('«one»\n«two»\nthree')
    expect(runMulti(splitSelectionIntoLines, 'a|b')).toBe('a|b')
  })

  it('changes the case of a selection, or the word at a caret, and keeps the caret', () => {
    expect(runMulti(changeCase(true), 'a «big» day')).toBe('a «BIG» day')
    expect(runMulti(changeCase(true), 'a bi|g day')).toBe('a BI|G day')
    expect(runMulti(changeCase(false), 'A BI|G «DAY»')).toBe('A bi|g «day»')
    expect(runMulti(changeCase(true), 'b|i|g')).toBe('B|I|G')
    expect(runMulti(changeCase(true), 'BI|G')).toBeNull()
    expect(runMulti(changeCase(true), 'a | b')).toBeNull()
    expect(runMulti(changeCase(true), '«stra\u00dfe»')).toBe('«STRASSE»')
  })

  it('ticks the task on each line with a caret, or unticks them all', () => {
    expect(runMulti(toggleTaskAtCaret, '- [ ] a|')).toBe('- [x] a|')
    expect(runMulti(toggleTaskAtCaret, '- [x] a|')).toBe('- [ ] a|')
    expect(runMulti(toggleTaskAtCaret, '> 1. [ ] q|')).toBe('> 1. [x] q|')
    expect(runMulti(toggleTaskAtCaret, '«- [x] a\n- [ ] b»')).toBe('«- [x] a\n- [x] b»')
    expect(runMulti(toggleTaskAtCaret, '- [x] a|\n- [X] b|')).toBe('- [ ] a|\n- [ ] b|')
    expect(runMulti(toggleTaskAtCaret, '- a|')).toBeNull()
    expect(runMulti(toggleTaskAtCaret, '```\n- [ ] a|\n```')).toBeNull()
    expect(runMulti(toggleTaskAtCaret, '«- [ ] a\n»- [ ] b')).toBe('«- [x] a\n»- [ ] b')
  })

  it('runs every edit command by ID, and nothing else', () => {
    expect(LINE_COMMANDS).toEqual(
      expect.arrayContaining([
        'edit.addCursorAbove',
        'edit.addCursorBelow',
        'edit.selectNextOccurrence',
        'edit.skipNextOccurrence',
        'edit.selectAllMatches',
        'edit.splitSelectionIntoLines',
        'edit.undoSelection',
        'edit.redoSelection',
        'edit.goToBracket',
        'edit.selectToBracket',
        'edit.upperCase',
        'edit.lowerCase',
        'edit.toggleTask',
      ]),
    )
    expect(runMulti((v) => runEditCommand(v, 'edit.upperCase'), 'a|b')).toBe('A|B')
    expect(runMulti((v) => runEditCommand(v, 'format.bold'), 'a|b')).toBeNull()
    expect(runMulti((v) => runEditCommand(v, 'edit.goToBracket'), '|(ab)')).toBe('(ab)|')
    expect(lineKeys()).toEqual(
      expect.arrayContaining([
        { id: 'edit.addCursorBelow', key: 'Shift-Ctrl-ArrowDown' },
        { id: 'edit.selectNextOccurrence', key: 'Mod-Alt-g' },
        { id: 'edit.goToBracket', key: 'Shift-Mod-\\' },
      ]),
    )
  })
})
