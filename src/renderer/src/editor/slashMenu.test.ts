import { CompletionContext } from '@codemirror/autocomplete'
import { history, undo } from '@codemirror/commands'
import { ChangeSet, EditorSelection, EditorState, Text, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { describe, expect, it, vi } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { nextSnippetField } from '@codemirror/autocomplete'
import { noteMarkdown } from './markdown'
import {
  matchesNothing,
  placeholderOut,
  SLASH_ITEMS,
  slashItems,
  slashMenu,
  slashSource,
  slashSpecs,
  slashTrigger,
  type SlashId,
} from './slashMenu'

// `^` marks a cursor and `«` `»` a selected range (`|` is a table's pipe here).
function state(marked: string) {
  const ranges = []
  let doc = ''
  let start = -1
  for (const ch of marked) {
    if (ch === '«') start = doc.length
    else if (ch === '»') ranges.push(EditorSelection.range(start, doc.length))
    else if (ch === '^') ranges.push(EditorSelection.cursor(doc.length))
    else doc += ch
  }
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges.length ? ranges : [EditorSelection.cursor(0)]),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      noteMarkdown,
      history(),
      slashMenu(),
    ],
  })
}

function show(s: EditorState): string {
  const marks: [number, string][] = []
  for (const r of s.selection.ranges) {
    if (r.empty) marks.push([r.from, '^'])
    else marks.push([r.from, '«'], [r.to, '»'])
  }
  let text = s.doc.toString()
  for (const [pos, mark] of marks.sort((a, b) => b[0] - a[0]))
    text = text.slice(0, pos) + mark + text.slice(pos)
  return text
}

const opens = (marked: string) => slashTrigger(state(marked)) !== null
const labels = (marked: string) => {
  const s = state(marked)
  const trigger = slashTrigger(s)
  return trigger ? slashItems(s, trigger).map((item) => item.label) : []
}

/** The state after picking `id` in the menu the marked text opens. */
function pick(marked: string, id: SlashId): EditorState {
  const s = state(marked)
  const trigger = slashTrigger(s)!
  const specs = slashSpecs(s, id, trigger.from, trigger.to)
  expect({ id, specs }).not.toEqual({ id, specs: null })
  return s.update(...specs!).state
}

/** A stand-in for the view an option's `apply` dispatches to. */
function fakeView(s: EditorState) {
  const view = {
    state: s,
    composing: false,
    dispatch(...specs: (Transaction | object)[]) {
      const [first] = specs
      view.state =
        specs.length === 1 && first && 'startState' in first
          ? (first as Transaction).state
          : view.state.update(...(specs as object[])).state
    },
  }
  return view
}

describe('slashTrigger', () => {
  it('opens for a slash at column 0 only', () => {
    expect(slashTrigger(state('/^'))).toEqual({ from: 0, to: 1, query: '' })
    expect(slashTrigger(state('First\n/quo^'))).toEqual({ from: 6, to: 10, query: 'quo' })
    expect(opens('x /^')).toBe(false)
    expect(opens('Some text /quo^')).toBe(false)
    expect(opens('- /^')).toBe(false)
    expect(opens('> /^')).toBe(false)
    expect(opens('a/^')).toBe(false)
    expect(opens(' /^')).toBe(false)
  })

  it('takes spaces inside the query but not right after the slash, nor another slash', () => {
    expect(slashTrigger(state('/task l^'))?.query).toBe('task l')
    expect(opens('/ ^')).toBe(false)
    expect(opens('/a/b^')).toBe(false)
    expect(opens(`/${'x'.repeat(64)}^`)).toBe(false)
  })

  it('does not open in code, HTML or front matter', () => {
    expect(opens('```\n/^\n```')).toBe(false)
    expect(opens('~~~js\n/^\n~~~')).toBe(false)
    expect(opens('<div>\n/^\n</div>')).toBe(false)
    expect(opens('---\n/^\n---\nBody')).toBe(false)
  })

  it('opens only for a single cursor', () => {
    expect(opens('«/»')).toBe(false)
    expect(opens('/^\n/^')).toBe(false)
  })
})

describe('slashItems', () => {
  it('lists the 19 items in their groups for an empty query', () => {
    const s = state('/^')
    const items = slashItems(s, slashTrigger(s)!)
    expect(items.map((i) => i.label)).toEqual([
      'Blockquote',
      'Codeblock',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Horizontal Rule',
      'Image File',
      'Link',
      'Ordered List',
      'Remote Image',
      'Task List',
      'Unordered List',
      'Caution',
      'Important',
      'Note',
      'Tip',
      'Warning',
      'Note Link',
    ])
    expect(items.map((i) => i.id)).toEqual(SLASH_ITEMS.map((i) => i.id))
    expect(new Set(items.slice(0, 13).map((i) => i.group))).toEqual(new Set(['basic']))
    expect(new Set(items.slice(13, 18).map((i) => i.group))).toEqual(new Set(['alerts']))
    expect(items[18]?.group).toBe('other')
    expect(items.find((i) => i.id === 'alert-note')?.hint).toBe('> [!NOTE]')
    expect(items.find((i) => i.id === 'heading3')?.hint).toBe('###')
    expect(items.find((i) => i.id === 'alert-tip')?.tone).toBe('tip')
  })

  it('writes the configured bullet in the list hints', () => {
    const s = state('/list^')
    const items = slashItems(s, slashTrigger(s)!)
    const bullet = items.find((i) => i.id === 'unorderedList')?.hint ?? ''
    expect(['-', '*']).toContain(bullet)
    expect(items.find((i) => i.id === 'taskList')?.hint).toBe(`${bullet} [ ]`)
  })

  it('matches a substring of the label, by match position, then the menu order', () => {
    expect(labels('/ist^')).toEqual(['Task List', 'Ordered List', 'Unordered List'])
    expect(labels('/co^')).toEqual(['Codeblock'])
    expect(labels('/CODE^')).toEqual(['Codeblock'])
    expect(labels('/heading 2^')).toEqual(['Heading 2'])
    expect(labels('/tion^')).toEqual(['Caution'])
  })

  it('marks the matched letters', () => {
    const s = state('/ist^')
    const [first] = slashItems(s, slashTrigger(s)!)
    expect(first?.ranges).toEqual([[6, 9]])
  })

  it('has no result when nothing matches', () => {
    expect(labels('/hd^')).toEqual([])
    expect(matchesNothing('hd')).toBe(true)
    expect(matchesNothing('he')).toBe(false)
  })

  it('leaves out the table, which only the palette offers', () => {
    expect(labels('/tab^')).toEqual([])
  })
})

describe('slashSpecs', () => {
  it('inserts a heading in place of the query', () => {
    expect(show(pick('/hea^', 'heading2'))).toBe('## ^')
    expect(show(pick('Intro\n\n/h4^', 'heading4'))).toBe('Intro\n\n#### ^')
  })

  it('inserts an alert with the cursor on its second line', () => {
    expect(show(pick('/no^', 'alert-note'))).toBe('> [!NOTE]\n> ^')
    expect(show(pick('/^', 'alert-caution'))).toBe('> [!CAUTION]\n> ^')
  })

  it('opens a code block with the cursor right after the opening fence', () => {
    expect(show(pick('/co^', 'codeblock'))).toBe('```^\n\n```')
  })

  it('runs the other items in place of the query', () => {
    expect(show(pick('/^', 'blockquote'))).toBe('> ^')
    expect(show(pick('/^', 'link'))).toBe('[^]()')
    expect(show(pick('/^', 'noteLink'))).toBe('[[^]]')
    expect(show(pick('/or^', 'orderedList'))).toBe('1. ^')
    expect(show(pick('/ima^', 'imageFile'))).toBe('^')
  })

  it('is one undo step that brings the `/query` back', () => {
    for (const { id } of SLASH_ITEMS) {
      if (id === 'remoteImage') continue
      const after = pick('Intro\n\n/que^', id)
      let undone = after
      undo({ state: after, dispatch: (tr) => (undone = tr.state) })
      expect({ id, text: show(undone) }).toEqual({ id, text: 'Intro\n\n/que^' })
    }
  })

  it('takes out only the placeholder an inline command ran beside', () => {
    const doc = Text.of(['See x'])
    const out = (changes: ChangeSet) => {
      const spec = placeholderOut(changes, 4, changes.apply(doc))
      return spec && ChangeSet.of(spec, changes.newLength).apply(changes.apply(doc)).toString()
    }
    expect(out(ChangeSet.of({ from: 4, insert: '[]()' }, doc.length))).toBe('See []()')
    expect(out(ChangeSet.of({ from: 4, to: 5, insert: '[x]()' }, doc.length))).toBeNull()
  })

  it('does nothing when the slash is gone', () => {
    const s = state('Intro ^')
    expect(slashSpecs(s, 'blockquote', 6, 6)).toBeNull()
  })
})

describe('slashSource', () => {
  const context = (s: EditorState, view?: Partial<EditorView>) =>
    new CompletionContext(s, s.selection.main.head, false, view as EditorView | undefined)

  it('offers the items in groups, with their hints', async () => {
    const result = await slashSource(context(state('/^')))
    expect(result?.filter).toBe(false)
    expect(result?.options).toHaveLength(19)
    const sections = new Set(
      result?.options.map((o) => (typeof o.section === 'object' ? o.section.name : o.section)),
    )
    expect([...sections]).toEqual(['Basic Formatting', 'Alerts', 'Other'])
    expect(result?.options[1]?.detail).toBe('```')
  })

  it('stays closed while an input method composes text', async () => {
    expect(await slashSource(context(state('/^'), { composing: true }))).toBeNull()
  })

  it('stays closed for its slash once nothing matches, also after Backspace', () => {
    let s = state('/h^')
    expect(slashSource(context(s))).not.toBeNull()
    s = s.update({ changes: { from: 2, insert: 'd' }, selection: { anchor: 3 } }).state
    expect(slashSource(context(s))).toBeNull()
    s = s.update({ changes: { from: 2, to: 3 }, selection: { anchor: 2 } }).state
    expect(show(s)).toBe('/h^')
    expect(slashSource(context(s))).toBeNull()
    // A new slash opens it again.
    s = s.update({ changes: { from: 0, to: 2, insert: '/' }, selection: { anchor: 1 } }).state
    expect(slashSource(context(s))).not.toBeNull()
  })

  it('writes Remote Image as a snippet: `alt` selected, Tab goes to `url`', () => {
    const s = state('/rem^')
    const result = slashSource(context(s))!
    const option = result.options.find((o) => o.label === 'Remote Image')!
    const view = fakeView(s)
    expect(typeof option.apply).toBe('function')
    ;(option.apply as (v: unknown, c: unknown, from: number, to: number) => void)(
      view,
      option,
      0,
      4,
    )
    expect(show(view.state)).toBe('![«alt»](url)')
    expect(nextSnippetField(view)).toBe(true)
    expect(show(view.state)).toBe('![alt](«url»)')
  })
})

describe('the menu at the end of a long note', () => {
  const block = '- one\n- two\n\n1. first\n2. second\n\nA paragraph of **plain** text.\n\n'
  const long = (size: number) => {
    let doc = ''
    while (doc.length < size) doc += block
    return doc
  }

  /** The longest the menu took for the keys `/`, `l`, `i` typed one after the other after `doc`. */
  function typing(doc: string): number {
    const start = state(`${doc}^`)
    expect(ensureSyntaxTree(start, start.doc.length, 30_000)).not.toBeNull()
    let worst = 0
    let typed = start
    for (const key of ['\n', '/', 'l', 'i']) {
      typed = typed.update({
        changes: { from: typed.doc.length, insert: key },
        selection: { anchor: typed.doc.length + 1 },
      }).state
      if (key === '\n') continue
      const from = performance.now()
      const trigger = slashTrigger(typed)
      const items = trigger ? slashItems(typed, trigger) : []
      worst = Math.max(worst, performance.now() - from)
      expect(items.length).toBeGreaterThan(0)
    }
    return worst
  }

  // The menu runs on every key typed after the slash. The items are listed
  // from the note with the query taken out: each such state needs a new parse
  // of the note's tail (about 5 ms at 200 KB), never one of the whole note,
  // and there is one per kind of item, not one per item. Inline and block
  // items make two a key, so the budget is two frames at 60 Hz; a parse of the
  // whole note per list item would take longer.
  it.for([
    ['an empty last paragraph', ''],
    ['after a bulleted item', '- item\n- '],
    ['after a numbered item', '1. item\n2. '],
    ['in a paragraph', 'text '],
  ])('lists the items within two frames while typing: %s', ([, tail], context) => {
    typing(`${long(2_000)}${tail}`)
    expectWithinBudget(context, typing(`${long(200_000)}${tail}`), 32)
  })

  // Inline items run beside a placeholder, block items on the line with the
  // query gone: two states with the query taken out, whatever the item count.
  it('makes one state with the query taken out per kind of item', () => {
    const s = state('Intro\n\n/li^')
    const trigger = slashTrigger(s)
    expect(trigger).not.toBeNull()
    const update = vi.spyOn(EditorState.prototype, 'update')
    try {
      expect(slashItems(s, trigger!).length).toBeGreaterThan(0)
      expect(update).toHaveBeenCalledTimes(2)
    } finally {
      update.mockRestore()
    }
  })
})
