import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { describe, expect, it, afterEach } from 'vitest'
import { effectiveKeymap } from '../commands/keymap'
import { setCommandKeys, command } from '../commands/registry'
import { ICONS } from '../icons/symbols'
import { noteMarkdown } from './markdown'
import { tableBarStatus } from './tableCommands'
import { TABLE_BAR_GROUPS, tableBarAt, tableBarTip } from './TableToolbar'
import { setToolbarFocus, toolbarOff, toolbarState } from './toolbarState'

const DOC = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter'

function make(head: number, opts: { focused?: boolean; off?: boolean; anchor?: number } = {}) {
  const extensions: Extension[] = [
    toolbarState,
    noteMarkdown,
    EditorState.allowMultipleSelections.of(true),
  ]
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

  it('is null with several carets', () => {
    const s = make(rowStart + 4).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(rowStart + 2),
        EditorSelection.cursor(rowStart + 4),
      ]),
    }).state
    expect(tableBarAt(s)).toBeNull()
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

  it('have a registry command and an icon each', () => {
    for (const b of TABLE_BAR_GROUPS.flat()) {
      expect(command(b.command)).toBeDefined()
      expect(ICONS).toContain(b.icon)
    }
  })

  it('show the command name and its key in effect', () => {
    const tip = (id: string) => tableBarTip(TABLE_BAR_GROUPS.flat().find((b) => b.id === id)!)
    expect(tip('insertRowBelow')).toEqual({ title: 'Insert Row Below', key: '⌥↩' })
    expect(tip('format').key).toBeUndefined()
    setCommandKeys(effectiveKeymap({ 'table.format': ['Mod+Alt+J'] }))
    expect(tip('format')).toEqual({ title: 'Format Table', key: '⌥⌘J' })
  })
})

describe('tableBarStatus', () => {
  const BIG = '| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |'
  const at = (doc: string, head: number) =>
    tableBarStatus(
      EditorState.create({ doc, selection: { anchor: head }, extensions: [noteMarkdown] }),
    )
  const off = (doc: string, head: number) => [...at(doc, head)!.disabled].sort()

  it('is null outside a table', () => {
    expect(at('plain text', 3)).toBeNull()
  })

  it('disables the moves that cannot act on the first row and column', () => {
    expect(off(BIG, BIG.indexOf('| 1') + 2)).toEqual(['moveColumnLeft', 'moveRowUp'])
  })

  it('disables Move Row Down on the last row and Move Column Right on the last column', () => {
    expect(off(BIG, BIG.indexOf('6'))).toEqual(['moveColumnRight', 'moveRowDown'])
  })

  it('disables every row command on the header row', () => {
    expect(off(BIG, 2)).toEqual(['deleteRow', 'moveColumnLeft', 'moveRowDown', 'moveRowUp'])
  })

  it('disables Delete Row on the only row and Delete Column on the only column', () => {
    const one = '| a |\n| - |\n| 1 |'
    expect(off(one, one.indexOf('1'))).toEqual([
      'deleteColumn',
      'deleteRow',
      'moveColumnLeft',
      'moveColumnRight',
      'moveRowDown',
      'moveRowUp',
    ])
  })

  it('leaves everything on in the middle of a larger table', () => {
    const grid = '| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |'
    expect(off(grid, grid.indexOf('5'))).toEqual([])
  })

  it('reports the alignment of the cursor column', () => {
    expect(at(BIG, BIG.indexOf('| 1') + 2)!.align).toBe('left')
    expect(at(BIG, BIG.indexOf('2'))!.align).toBe('right')
    expect(at(DOC, rowStart + 2)!.align).toBe('none')
  })
})
