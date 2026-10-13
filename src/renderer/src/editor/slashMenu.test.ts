import { CompletionContext } from '@codemirror/autocomplete'
import { history, undo } from '@codemirror/commands'
import { ChangeSet, EditorSelection, EditorState, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ensureSyntaxTree } from '@codemirror/language'
import { describe, expect, it, vi } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { command, formatOf, insertOf } from '../commands/registry'
import { t } from '../i18n'
import { FORMAT_COMMANDS } from './formats'
import { INSERT_COMMANDS } from './insert'
import { noteMarkdown } from './markdown'
import {
  placeholderOut,
  SLASH_COMMANDS,
  slashItems,
  slashSource,
  slashSpecs,
  slashTrigger,
  type SlashCommandId,
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
    extensions: [EditorState.allowMultipleSelections.of(true), noteMarkdown, history()],
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
const label = (id: SlashCommandId) => t(command(id).label)

/** The state after picking `id` in the menu the marked text opens. */
function pick(marked: string, id: SlashCommandId): EditorState {
  const s = state(marked)
  const trigger = slashTrigger(s)!
  const specs = slashSpecs(s, id, trigger.from, trigger.to)
  expect({ id, specs }).not.toEqual({ id, specs: null })
  return s.update(...specs!).state
}

/** The same command run on the text without the `/query` (`^` at the slash). */
function direct(marked: string, id: SlashCommandId): EditorState {
  const s = state(marked.replace(/\/[^\s/^]*\^/, '^'))
  const format = formatOf(id)
  const insert = insertOf(id)
  const spec = format ? FORMAT_COMMANDS[format](s) : insert ? INSERT_COMMANDS[insert](s) : null
  expect({ id, spec }).not.toEqual({ id, spec: null })
  return s.update(spec!).state
}

describe('slashTrigger', () => {
  it('opens for a slash at the start of a line or after a space', () => {
    expect(slashTrigger(state('/^'))).toEqual({ from: 0, to: 1, query: '' })
    expect(slashTrigger(state('Some text /quo^'))).toEqual({ from: 10, to: 14, query: 'quo' })
    expect(opens('First\n/^')).toBe(true)
    expect(opens('Text\t/^')).toBe(true)
    expect(opens('- /^')).toBe(true)
    expect(opens('> /^')).toBe(true)
    expect(opens('# Title /^')).toBe(true)
    expect(opens('| a | /^ |\n| --- | --- |')).toBe(true)
    // In a link's text, which is prose.
    expect(opens('[see /^](https://example.com)')).toBe(true)
  })

  it('does not open after other characters', () => {
    expect(opens('a/^')).toBe(false)
    expect(opens('1/2^')).toBe(false)
    expect(opens('src/x^')).toBe(false)
    expect(opens('and/or^')).toBe(false)
    expect(opens('https://example.com/pa^')).toBe(false)
    expect(opens('[a](/x^)')).toBe(false)
    expect(opens('</x^')).toBe(false)
    expect(opens('a //^')).toBe(false)
  })

  it('closes once the query has a space or another slash', () => {
    expect(opens('/code bl^')).toBe(false)
    expect(opens('/a/b^')).toBe(false)
    expect(opens('/ ^')).toBe(false)
    expect(opens(`/${'x'.repeat(64)}^`)).toBe(false)
  })

  it('does not open in code, HTML, comments or front matter', () => {
    expect(opens('```\n/^\n```')).toBe(false)
    expect(opens('```\nx /^')).toBe(false)
    expect(opens('~~~js\n  /^\n~~~')).toBe(false)
    expect(opens('    /^')).toBe(false)
    expect(opens('\t/^')).toBe(false)
    expect(opens('    code /^')).toBe(false)
    expect(opens('a `code /^` b')).toBe(false)
    expect(opens('<div>\n/^\n</div>')).toBe(false)
    expect(opens('a <img src="x.png" /^> b')).toBe(false)
    expect(opens('<!-- /^ -->')).toBe(false)
    expect(opens('a <!-- /^ --> b')).toBe(false)
    expect(opens('---\ntitle: /^\n---\nBody')).toBe(false)
  })

  it('does not open in a link address or title', () => {
    expect(opens('[ref]: /^')).toBe(false)
    expect(opens('[ref]: /path^')).toBe(false)
    expect(opens('[a]( /x^)')).toBe(false)
    expect(opens('[a](https://example.com "a /t^")')).toBe(false)
  })

  it('leaves a slash in the query of a note link to the note popup', () => {
    expect(opens('[[Q1 /^]]')).toBe(false)
    expect(opens('See [[Q1 /^')).toBe(false)
    // After a finished note link it opens.
    expect(opens('[[Q1]] /^')).toBe(true)
  })

  it('opens only for a single cursor', () => {
    expect(opens('«/»')).toBe(false)
    expect(opens('/^ and /^')).toBe(false)
  })
})

describe('slashItems', () => {
  it('offers every insertion in menu order for an empty query', () => {
    expect(labels('/^')).toEqual(SLASH_COMMANDS.map(label))
    expect(labels('/^')).toEqual([
      'Link',
      'Image',
      'Quote',
      'Note Alert',
      'Tip Alert',
      'Important Alert',
      'Warning Alert',
      'Caution Alert',
      'Note Link',
      'Code Block',
      'Table',
      'Bulleted List',
      'Numbered List',
      'Task List',
      'Horizontal Rule',
    ])
  })

  it('filters by the query, best match first', () => {
    expect(labels('/quo^')[0]).toBe('Quote')
    expect(labels('/tab^')[0]).toBe('Table')
    expect(labels('/hr^')[0]).toBe('Horizontal Rule')
    expect(labels('/li^')[0]).toBe('Link')
    expect(labels('/warn^')).toEqual(['Warning Alert'])
    expect(labels('/CODE^')[0]).toBe('Code Block')
    expect(labels('/zzz^')).toEqual([])
  })

  it('marks the matched letters', () => {
    const s = state('/tab^')
    const [first] = slashItems(s, slashTrigger(s)!)
    expect(first?.ranges).toEqual([[0, 3]])
  })

  it('leaves out what would take a format off rather than add it', () => {
    expect(labels('- item /^')).not.toContain('Bulleted List')
    expect(labels('- item /^')).toContain('Numbered List')
    expect(labels('> quoted /^')).not.toContain('Quote')
    const inAlert = labels('> [!NOTE]\n> text /^')
    expect(inAlert).not.toContain('Note Alert')
    expect(inAlert).toContain('Tip Alert')
    // A quote's toggle would take the alert's `> [!NOTE]` line off.
    expect(inAlert).not.toContain('Quote')
    expect(labels('> [!NOTE]\n> body\n> /^')).not.toContain('Quote')
    // A table cell takes inline items; a table or rule goes after the table.
    expect(labels('| a | /^ |\n| --- | --- |')).toEqual([
      'Link',
      'Image',
      'Note Link',
      'Table',
      'Horizontal Rule',
    ])
    // A link cannot go into a link.
    const inLink = labels('[see /^](https://example.com)')
    expect(inLink).not.toContain('Link')
    expect(inLink).not.toContain('Image')
    expect(inLink).not.toContain('Note Link')
    expect(inLink).toContain('Quote')
  })
})

describe('slashSpecs', () => {
  it('runs the registry command in place of the `/query`', () => {
    const cases = ['/^', 'Intro /q^', 'First\n/x^\nLast', '- item /^']
    for (const marked of cases) {
      for (const id of SLASH_COMMANDS) {
        const s = state(marked)
        const trigger = slashTrigger(s)!
        const specs = slashSpecs(s, id, trigger.from, trigger.to)
        // A command that does nothing here is neither offered nor picked.
        if (!specs) continue
        expect({ id, marked, text: show(pick(marked, id)) }).toEqual({
          id,
          marked,
          text: show(direct(marked, id)),
        })
      }
    }
    expect(show(pick('Intro /quo^', 'format.quote'))).toBe('> Intro ^')
    expect(show(pick('/^', 'format.link'))).toBe('[^]()')
    expect(show(pick('See /img^', 'insert.image'))).toBe('See ![^]()')
    expect(show(pick('See /^', 'insert.noteLink'))).toBe('See [[^]]')
    expect(show(pick('/bul^', 'format.bulletList'))).toBe('- ^')
    expect(show(pick('/hr^', 'format.horizontalRule'))).toBe('***\n^')
  })

  it('puts a code block inside the list item it is picked in, keeping the marker', () => {
    expect(show(pick('1. Run this:\n2. /code^', 'format.codeBlock'))).toBe(
      '1. Run this:\n2. ```\n   ^\n   ```',
    )
    expect(show(pick('- a\n  - /^', 'format.codeBlock'))).toBe('- a\n  - ```\n    ^\n    ```')
    expect(show(pick('1. Run this:\n   /^', 'format.codeBlock'))).toBe(
      '1. Run this:\n   ```\n   ^\n   ```',
    )
  })

  it('is one undo step that brings the `/query` back', () => {
    for (const id of SLASH_COMMANDS) {
      const after = pick('Intro\n/que^', id)
      let undone = after
      undo({ state: after, dispatch: (tr) => (undone = tr.state) })
      expect({ id, text: show(undone) }).toEqual({ id, text: 'Intro\n/que^' })
    }
  })

  it('keeps a list item under a paragraph a list item when the query goes', () => {
    // Without the query `- ` under a paragraph would be a setext underline
    // and `* ` paragraph text: a blank line above keeps the item apart.
    const table = ['| ^    |     |', '| --- | --- |', '|     |     |'].join('\n')
    for (const marker of ['-', '*', '+']) {
      const marked = `para\n${marker} /^`
      expect(show(pick(marked, 'insert.table'))).toBe(`para\n\n${table}`)
      expect(show(pick(marked, 'format.horizontalRule'))).toBe('para\n\n---\n^')
      expect(show(pick(marked, 'format.quote'))).toBe(`para\n\n> ${marker} ^`)
      expect(show(pick(marked, 'format.numberedList'))).toBe('para\n\n1. ^')
      expect(show(pick(marked, 'format.taskList'))).toBe(`para\n\n${marker} [ ] ^`)
      // The code block goes inside the item, not the paragraph.
      expect(show(pick(marked, 'format.codeBlock'))).toBe(
        show(pick(`para\n\n${marker} /^`, 'format.codeBlock')),
      )
      expect(show(pick(marked, 'format.codeBlock'))).toBe(`para\n\n${marker} \`\`\`\n  ^\n  \`\`\``)
      // Every block item does what it does to an item after a blank line.
      expect(labels(marked)).toEqual(labels(`para\n\n${marker} /^`))
      for (const id of SLASH_COMMANDS) {
        const s = state(marked)
        const trigger = slashTrigger(s)!
        if (!slashSpecs(s, id, trigger.from, trigger.to)) continue
        if (id === 'format.link' || id === 'insert.image' || id === 'insert.noteLink') continue
        expect({ id, text: show(pick(marked, id)) }).toEqual({
          id,
          text: show(pick(`para\n\n${marker} /^`, id)),
        })
      }
      // An inline insertion fills the item and needs no blank line.
      expect(show(pick(marked, 'format.link'))).toBe(`para\n${marker} [^]()`)
    }
    expect(labels('para\n- /^')).toContain('Numbered List')
    expect(labels('para\n- /^')).toContain('Task List')
    expect(labels('para\n- /^')).not.toContain('Bulleted List')
    // In a quote the blank line is the quote's.
    const quoted = table
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
    expect(show(pick('> para\n> - /^', 'insert.table'))).toBe(`> para\n>\n${quoted}`)
    // An item with other text, or in a list, stays as it is.
    expect(show(pick('- a\n- /^', 'format.horizontalRule'))).toBe('- a\n\n---\n^')
    expect(show(pick('para\n- a /^', 'format.horizontalRule'))).toBe('para\n- a \n\n---\n^')
  })

  it('takes out only the placeholder an inline command ran beside', () => {
    // `See x`: the placeholder at 4 stands in for the query.
    const doc = Text.of(['See x'])
    const out = (changes: ChangeSet) => {
      const spec = placeholderOut(changes, 4, changes.apply(doc))
      return spec && ChangeSet.of(spec, changes.newLength).apply(changes.apply(doc)).toString()
    }
    // Inserted before or around it, as links are: it goes, the insertion stays.
    expect(out(ChangeSet.of({ from: 4, insert: '[]()' }, doc.length))).toBe('See []()')
    const noteLink = ChangeSet.of(
      [
        { from: 4, insert: '[[' },
        { from: 4, insert: ']]' },
      ],
      doc.length,
    )
    expect(out(noteLink)).toBe('See [[]]')
    // A command that rewrote the placeholder acted on it: nothing is taken out of its result.
    expect(out(ChangeSet.of({ from: 4, to: 5, insert: '[x]()' }, doc.length))).toBeNull()
  })

  it('does nothing when the slash is gone', () => {
    const s = state('Intro ^')
    expect(slashSpecs(s, 'format.quote', 6, 6)).toBeNull()
  })
})

describe('slashSource', () => {
  const context = (marked: string, view?: Partial<EditorView>) => {
    const s = state(marked)
    return new CompletionContext(s, s.selection.main.head, false, view as EditorView | undefined)
  }

  it('offers the items from the slash, filtered by the menu itself', async () => {
    const result = await slashSource(context('Intro /tab^'))
    expect(result?.from).toBe(6)
    expect(result?.filter).toBe(false)
    expect(result?.options[0]?.label).toBe('Table')
  })

  it('ranks again as the query is typed, without waiting for a new query', async () => {
    const first = await slashSource(context('Intro /^'))
    expect(first?.update).toBeTypeOf('function')
    const typed = context('Intro /tab^')
    const next = first!.update!(first!, 6, typed.pos, typed)
    expect(next?.from).toBe(6)
    expect(next?.options[0]?.label).toBe('Table')
    // A query that matches nothing, or ends with a space, closes the list.
    const none = context('Intro /zzz^')
    expect(first!.update!(first!, 6, none.pos, none)).toBeNull()
    const space = context('Intro /tab ^')
    expect(first!.update!(first!, 6, space.pos, space)).toBeNull()
  })

  it('stays closed while an input method composes text', async () => {
    expect(await slashSource(context('/^', { composing: true }))).toBeNull()
    expect(await slashSource(context('/^', { composing: false }))).not.toBeNull()
  })

  it('stays closed where nothing matches', async () => {
    expect(await slashSource(context('/zzz^'))).toBeNull()
    expect(await slashSource(context('a/^'))).toBeNull()
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
    for (const key of ['/', 'l', 'i']) {
      typed = typed.update({
        changes: { from: typed.doc.length, insert: key },
        selection: { anchor: typed.doc.length + 1 },
      }).state
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
  // query gone, so there are two; a list item that was only the query may need
  // a third, with a blank line above it.
  it.for([
    ['in a paragraph', 'Intro /li^', 2],
    ['in a list item', '- one\n- two /li^', 2],
    ['in a list item that was only the query', 'Intro\n- /li^', 3],
  ] as const)(
    'makes one state with the query taken out per kind of item: %s',
    ([, doc, states]) => {
      const s = state(doc)
      const trigger = slashTrigger(s)
      expect(trigger).not.toBeNull()
      const update = vi.spyOn(EditorState.prototype, 'update')
      try {
        expect(slashItems(s, trigger!).length).toBeGreaterThan(0)
        expect(update).toHaveBeenCalledTimes(states)
      } finally {
        update.mockRestore()
      }
    },
  )
})
