import { history } from '@codemirror/commands'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { noteMarkdown } from './markdown'
import { slashItems, slashMenu, slashTrigger } from './slashMenu'

// A time budget on a 200 KB note: out of the fast suite, so it never shares the CPU with it.

function state(marked: string) {
  const doc = marked.replace('^', '')
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(marked.indexOf('^')),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      noteMarkdown,
      history(),
      slashMenu(),
    ],
  })
}

describe('the menu at the end of a long note', () => {
  const block = '- one\n- two\n\n1. first\n2. second\n\nA paragraph of **plain** text.\n\n'
  const long = (size: number) => {
    let doc = ''
    while (doc.length < size) doc += block
    return doc
  }

  /**
   * The longest the menu took for the keys `/`, `l`, `i` typed one after the other after `doc`.
   * Each key counts its fastest of three runs on the same state: a garbage collection
   * or a busy runner can stretch one run, but a slow path is slow every time.
   */
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
      let fastest = Infinity
      for (let run = 0; run < 3; run++) {
        const from = performance.now()
        const trigger = slashTrigger(typed)
        const items = trigger ? slashItems(typed, trigger) : []
        fastest = Math.min(fastest, performance.now() - from)
        expect(items.length).toBeGreaterThan(0)
      }
      worst = Math.max(worst, fastest)
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
})
