import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { toggleInline } from './formats'
import { noteMarkdown } from './markdown'
import {
  barFocusIsFree,
  barHoldsFocus,
  hideToolbar,
  leavesEditor,
  releaseToolbar,
  setToolbarFocus,
  toolbarState,
  toolbarVisible,
} from './toolbarState'

function start(): EditorState {
  return EditorState.create({
    doc: 'one two three',
    extensions: [toolbarState, noteMarkdown],
  })
}

const step = (s: EditorState, spec: TransactionSpec) => s.update(spec).state
const focus = (s: EditorState) => step(s, { effects: setToolbarFocus.of(true) })
const select = (s: EditorState, from: number, to: number, userEvent = 'select.pointer') =>
  step(s, { selection: EditorSelection.range(from, to), userEvent })

describe('toolbar visibility', () => {
  it('shows for a non-empty selection in the focused editor', () => {
    const s = select(focus(start()), 4, 7)
    expect(toolbarVisible(s)).toBe(true)
  })

  it('stays hidden while the editor is not focused', () => {
    const s = select(start(), 4, 7)
    expect(toolbarVisible(s)).toBe(false)
    expect(toolbarVisible(step(focus(s), { effects: setToolbarFocus.of(false) }))).toBe(false)
  })

  it('hides for a collapsed selection', () => {
    const s = select(select(focus(start()), 4, 7), 5, 5)
    expect(toolbarVisible(s)).toBe(false)
  })

  it('hides on request (Escape) until the selection is changed by the user', () => {
    let s = step(select(focus(start()), 4, 7), { effects: hideToolbar.of(null) })
    expect(toolbarVisible(s)).toBe(false)
    s = select(s, 4, 9, 'select')
    expect(toolbarVisible(s)).toBe(true)
  })

  it('shows again for the next selection once released after typing', () => {
    let s = step(select(focus(start()), 4, 7), {
      changes: { from: 0, insert: '/' },
      userEvent: 'input.type',
    })
    s = step(s, { effects: releaseToolbar.of(null) })
    s = select(s, 5, 8, 'select')
    expect(toolbarVisible(s)).toBe(true)
  })

  it('hides while typing, even when a selection remains', () => {
    let s = select(focus(start()), 4, 7)
    s = step(s, {
      changes: { from: 0, insert: 'x' },
      selection: EditorSelection.range(5, 8),
      userEvent: 'input.type',
    })
    expect(toolbarVisible(s)).toBe(false)
    s = step(s, { changes: { from: 0, to: 1 }, userEvent: 'delete.backward' })
    expect(toolbarVisible(s)).toBe(false)
  })

  it('stays up after a format command and after edits from elsewhere', () => {
    let s = select(focus(start()), 4, 7)
    const spec = toggleInline(s, 'bold')
    expect(spec).not.toBeNull()
    s = step(s, spec ?? {})
    expect(toolbarVisible(s)).toBe(true)
    s = step(s, { changes: { from: 0, insert: 'remote ' } })
    expect(toolbarVisible(s)).toBe(true)
  })

  it('shows again for a selection made without a select event (Edit > Select All)', () => {
    let s = select(focus(start()), 4, 7)
    s = step(s, { changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
    expect(toolbarVisible(s)).toBe(false)
    s = step(s, { selection: EditorSelection.range(0, s.doc.length) })
    expect(toolbarVisible(s)).toBe(true)
  })

  it('stays hidden after typing when an edit from elsewhere moves the selection', () => {
    let s = select(focus(start()), 4, 7)
    s = step(s, { changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
    s = step(s, { changes: { from: 0, insert: 'remote ' } })
    expect(toolbarVisible(s)).toBe(false)
  })
})

describe('leavesEditor', () => {
  const inside = { closest: (selector: string) => (selector === '.cm-float-bar' ? {} : null) }
  const outside = { closest: () => null }

  it('keeps focus in the editor when it moves to a button of a floating bar', () => {
    expect(leavesEditor(inside)).toBe(false)
  })

  it('leaves the editor for any other element, or for nothing', () => {
    expect(leavesEditor(outside)).toBe(true)
    expect(leavesEditor(null)).toBe(true)
  })
})

type Who = 'button' | 'other' | 'host' | 'body' | null

function fakeBar(rootActive: Who, docActive: Who): HTMLElement {
  const nodes = { button: {}, other: {}, host: {}, body: {} }
  const pick = (who: Who) => (who ? nodes[who] : null)
  return {
    contains: (n: unknown) => n === nodes.button,
    getRootNode: () => ({ activeElement: pick(rootActive), host: nodes.host }),
    ownerDocument: { activeElement: pick(docActive), body: nodes.body },
  } as unknown as HTMLElement
}

describe('focus on a floating bar in a shadow root', () => {
  it('sees a bar button the shadow root reports as active', () => {
    expect(barHoldsFocus(fakeBar('button', 'host'))).toBe(true)
  })

  it('does not hold focus when another control or nothing is active', () => {
    expect(barHoldsFocus(fakeBar('other', 'host'))).toBe(false)
    expect(barHoldsFocus(fakeBar(null, 'host'))).toBe(false)
  })

  it('is free to take focus back from the bar, from nowhere, or from the host', () => {
    expect(barFocusIsFree(fakeBar('button', 'host'))).toBe(true)
    expect(barFocusIsFree(fakeBar(null, 'body'))).toBe(true)
    expect(barFocusIsFree(fakeBar(null, 'host'))).toBe(true)
  })

  it('leaves focus alone when the user went to another field', () => {
    expect(barFocusIsFree(fakeBar('other', 'host'))).toBe(false)
    expect(barFocusIsFree(fakeBar(null, 'other'))).toBe(false)
  })
})
