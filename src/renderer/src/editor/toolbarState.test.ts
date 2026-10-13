import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { toggleInline } from './formats'
import { noteMarkdown } from './markdown'
import { hideToolbar, setToolbarFocus, toolbarState, toolbarVisible } from './toolbarState'

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
