import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it, afterEach } from 'vitest'
import { effectiveKeymap } from '../commands/keymap'
import { setCommandKeys } from '../commands/registry'
import { noteMarkdown } from './markdown'
import { TABLE_BAR_GROUPS, tableBarAt, tableBarTip } from './TableToolbar'
import { setToolbarFocus, toolbarOff, toolbarState } from './toolbarState'

const DOC = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter'

function make(head: number, opts: { focused?: boolean; off?: boolean; anchor?: number } = {}) {
  const extensions: Extension[] = [toolbarState, noteMarkdown]
  if (opts.off) extensions.push(toolbarOff.of(true))
  let state = EditorState.create({
    doc: DOC,
    selection: EditorSelection.single(opts.anchor ?? head, head),
    extensions,
  })
  if (opts.focused ?? true) state = state.update({ effects: setToolbarFocus.of(true) }).state
  return state
}

const rowStart = DOC.indexOf('| 1')

describe('tableBarAt', () => {
  it('is the start of the caret row inside a table', () => {
    expect(tableBarAt(make(rowStart + 4))).toEqual({ pos: rowStart })
    expect(tableBarAt(make(DOC.indexOf('| a') + 2))).toEqual({ pos: DOC.indexOf('| a') })
  })

  it('is null outside a table', () => {
    expect(tableBarAt(make(2))).toBeNull()
    expect(tableBarAt(make(DOC.length))).toBeNull()
  })

  it('is null while text is selected', () => {
    expect(tableBarAt(make(rowStart + 4, { anchor: rowStart + 2 }))).toBeNull()
  })

  it('is null while the editor is not focused', () => {
    expect(tableBarAt(make(rowStart + 4, { focused: false }))).toBeNull()
  })

  it('is null when the toolbar setting is off', () => {
    expect(tableBarAt(make(rowStart + 4, { off: true }))).toBeNull()
  })
})

describe('the table bar buttons', () => {
  afterEach(() => setCommandKeys(undefined))

  it('come in the groups of the issue, in order', () => {
    expect(TABLE_BAR_GROUPS.map((g) => g.map((b) => b.id))).toEqual([
      ['format'],
      ['alignLeft', 'alignCenter', 'alignRight', 'alignNone'],
      ['moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight'],
      ['insertRowBelow', 'insertColumnRight'],
      ['deleteRow', 'deleteColumn'],
    ])
  })

  it('show the command name and its key in effect', () => {
    const tip = (id: string) => tableBarTip(TABLE_BAR_GROUPS.flat().find((b) => b.id === id)!)
    expect(tip('insertRowBelow')).toEqual({ title: 'Insert Row Below', key: '⌥↩' })
    expect(tip('format').key).toBeUndefined()
    setCommandKeys(effectiveKeymap({ 'table.format': ['Mod+Alt+J'] }))
    expect(tip('format')).toEqual({ title: 'Format Table', key: '⌥⌘J' })
  })
})
