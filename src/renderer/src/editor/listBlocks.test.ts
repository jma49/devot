import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { runEditCommand } from './lineCommands'
import { noteMarkdown } from './markdown'

function state(marked: string): EditorState {
  const from = marked.includes('«') ? marked.indexOf('«') : marked.indexOf('|')
  const to = marked.includes('»') ? marked.indexOf('»') - 1 : from
  return EditorState.create({
    doc: marked.replace(/[«»|]/g, ''),
    selection: EditorSelection.range(from, to),
    extensions: [noteMarkdown, history()],
  })
}

function mark(s: EditorState): string {
  const { from, to } = s.selection.main
  const text = s.doc.toString()
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}«${text.slice(from, to)}»${text.slice(to)}`
}

/** Runs the command; returns the marked text after it and the state before, to check undo. */
function press(id: Parameters<typeof runEditCommand>[1], marked: string) {
  const before = state(marked)
  let now = before
  let dispatches = 0
  const view = {
    get state() {
      return now
    },
    dispatch: (spec: Parameters<EditorState['update']>[0]) => {
      dispatches++
      now = now.update(spec).state
    },
  } as unknown as EditorView
  expect(runEditCommand(view, id)).toBe(true)
  return { after: mark(now), now, before, dispatches }
}

const down = (marked: string) => press('edit.moveLineDown', marked).after
const up = (marked: string) => press('edit.moveLineUp', marked).after
const indent = (marked: string) => press('edit.indent', marked).after
const outdent = (marked: string) => press('edit.outdent', marked).after

describe('Move Line Down and Up on a list item', () => {
  it('swaps a parent with its children past the next sibling', () => {
    expect(down('- a|\n  - a1\n  - a2\n- b')).toBe('- b\n- a|\n  - a1\n  - a2')
    expect(down('- a\n  - a1\n  - a2\n- b|\n- c')).toBe('- a\n  - a1\n  - a2\n- c\n- b|')
  })

  it('swaps with the previous sibling and its children going up', () => {
    expect(up('- a\n  - a1\n  - a2\n- b|')).toBe('- b|\n- a\n  - a1\n  - a2')
    expect(up('- a\n- b|\n  - b1\n- c')).toBe('- b|\n  - b1\n- a\n- c')
  })

  it('moves a nested item among its own siblings only', () => {
    expect(down('- a\n  - x|\n    - deep\n  - y\n- b')).toBe('- a\n  - y\n  - x|\n    - deep\n- b')
    expect(up('- a\n  - x\n  - y|')).toBe('- a\n  - y|\n  - x')
  })

  it('leaves the list alone at the first and last item', () => {
    expect(up('- a|\n  - a1\n- b')).toBe('- a|\n  - a1\n- b')
    expect(down('- a\n- b|\n  - b1')).toBe('- a\n- b|\n  - b1')
    expect(down('- a\n  - x\n  - y|\n- b')).toBe('- a\n  - x\n  - y|\n- b')
  })

  it('keeps the caret and selection on the same text', () => {
    expect(down('- al|pha\n  - kid\n- beta')).toBe('- beta\n- al|pha\n  - kid')
    expect(down('- «alpha»\n  - kid\n- beta')).toBe('- beta\n- «alpha»\n  - kid')
    expect(up('- a\n- b\n  - x\n  - ki|d')).toBe('- a\n- b\n  - ki|d\n  - x')
  })

  it('keeps task items whole and their ticks', () => {
    expect(down('- [x] done|\n  - [ ] sub\n- [ ] open')).toBe(
      '- [ ] open\n- [x] done|\n  - [ ] sub',
    )
    expect(up('- [ ] a\n- [x] b|\n  - [x] c')).toBe('- [x] b|\n  - [x] c\n- [ ] a')
  })

  it('renumbers a numbered list, keeping its first number', () => {
    expect(down('1. a|\n   1. x\n2. b\n3. c')).toBe('1. b\n2. a|\n   1. x\n3. c')
    expect(up('1. a\n2. b|\n3. c')).toBe('1. b|\n2. a\n3. c')
    expect(down('5. a|\n6. b')).toBe('5. b\n6. a|')
    expect(down('2. a\n3. b\n4. c|')).toBe('2. a\n3. b\n4. c|')
  })

  it('moves the children with a number that gains or loses a digit', () => {
    expect(down('9. a|\n   - x\n10. b\n    - y')).toBe('9. b\n   - y\n10. a|\n    - x')
  })

  it('keeps blank lines between loose items in place', () => {
    expect(down('- a|\n  - a1\n\n- b\n\n- c')).toBe('- b\n\n- a|\n  - a1\n\n- c')
  })

  it('works inside a quote', () => {
    expect(down('> - a|\n>   - a1\n> - b')).toBe('> - b\n> - a|\n>   - a1')
  })

  it('is one undo step', () => {
    const { now, before, dispatches } = press('edit.moveLineDown', '- a|\n  - a1\n  - a2\n- b')
    expect(dispatches).toBe(1)
    let restored = now
    expect(
      undo({
        state: now,
        dispatch: (tr) => {
          restored = tr.state
        },
      }),
    ).toBe(true)
    expect(restored.doc.toString()).toBe(before.doc.toString())
  })

  it('moves lines as before outside a list', () => {
    expect(down('one|\ntwo\nthree')).toBe('two\none|\nthree')
    expect(up('one\ntwo|\nthree')).toBe('two|\none\nthree')
    expect(down('# Head|\n- a\n- b')).toBe('- a\n# Head|\n- b')
  })

  it('moves the selected lines when a selection reaches into several items', () => {
    expect(down('- «a\n  - a1»\n- b')).toBe('- b\n- «a\n  - a1»')
  })

  it('moves a code block line inside an item as part of that item', () => {
    expect(down('- a\n  ```\n  co|de\n  ```\n- b')).toBe('- b\n- a\n  ```\n  co|de\n  ```')
  })
})

describe('Indent and Outdent on a list item', () => {
  it('indent takes the children along', () => {
    expect(indent('- a\n- b|\n  - c\n    - d\n- e')).toBe('- a\n  - b|\n    - c\n      - d\n- e')
  })

  it('outdent takes the children along', () => {
    expect(outdent('- a\n  - b|\n    - c\n  - d')).toBe('- a\n- b|\n  - c\n  - d')
  })

  it('nests a numbered item as far as the item above needs, renumbering', () => {
    expect(indent('1. a\n2. b|\n   - x\n3. c')).toBe('1. a\n   1. b|\n      - x\n2. c')
    expect(outdent('1. a\n   1. b|\n      - x\n2. c')).toBe('1. a\n2. b|\n   - x\n3. c')
  })

  it('handles task items', () => {
    expect(indent('- [ ] a\n- [x] b|\n  - [ ] c')).toBe('- [ ] a\n  - [x] b|\n    - [ ] c')
  })

  it('does nothing for outdent at the top level and indent of a first item', () => {
    expect(outdent('- a|\n  - b')).toBe('- a|\n  - b')
    expect(indent('- a|\n  - b')).toBe('- a|\n  - b')
    expect(indent('1. a|\n2. b')).toBe('1. a|\n2. b')
  })

  it('acts on the item the caret is in, not its parent', () => {
    expect(indent('- a\n  - b\n  - c|\n    - d')).toBe('- a\n  - b\n    - c|\n      - d')
  })

  it('is one undo step', () => {
    const { now, before, dispatches } = press('edit.indent', '- a\n- b|\n  - c')
    expect(dispatches).toBe(1)
    let restored = now
    undo({
      state: now,
      dispatch: (tr) => {
        restored = tr.state
      },
    })
    expect(restored.doc.toString()).toBe(before.doc.toString())
  })

  it('indents and outdents lines as before outside a list', () => {
    expect(indent('text|')).toBe('  text|')
    expect(outdent('  text|')).toBe('text|')
    expect(indent('«one\ntwo»')).toBe('  «one\n  two»')
  })
})
