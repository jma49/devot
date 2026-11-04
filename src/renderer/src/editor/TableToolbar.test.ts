import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { showTooltip, type Tooltip } from '@codemirror/view'
import { describe, expect, it, afterEach } from 'vitest'
import { effectiveKeymap } from '../commands/keymap'
import { setCommandKeys, command } from '../commands/registry'
import { ICONS } from '../icons/symbols'
import { noteMarkdown } from './markdown'
import { tableBarStatus } from './tableCommands'
import {
  TABLE_BAR_GROUPS,
  placeTableBar,
  tableBarAbove,
  tableBarAt,
  tableBarTip,
  tableToolbar,
} from './TableToolbar'
import { setToolbarFocus, toolbarOff, toolbarState } from './toolbarState'
import { writeActive } from './write/active'

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

describe('tableBarAbove', () => {
  it('is the start of the table whichever row the caret is on', () => {
    const header = DOC.indexOf('| a')
    expect(tableBarAbove(make(rowStart + 4))).toEqual({ pos: header })
    expect(tableBarAbove(make(header + 2))).toEqual({ pos: header })
  })

  it('is null where the bar does not show', () => {
    expect(tableBarAbove(make(2))).toBeNull()
    expect(tableBarAbove(make(rowStart + 4, { focused: false }))).toBeNull()
    expect(tableBarAbove(make(rowStart + 4, { off: true }))).toBeNull()
  })
})

describe('placeTableBar', () => {
  const bar = { height: 40 }

  it('puts the bar above the table, outside its grid, when there is room', () => {
    const y = placeTableBar({ top: 300, headerBottom: 340 }, { top: 100 }, bar)
    expect(y + bar.height).toBeLessThanOrEqual(300)
  })

  it('pins the bar below the header row when the table starts too near the scroller top', () => {
    expect(placeTableBar({ top: 110, headerBottom: 150 }, { top: 100 }, bar)).toBe(150)
  })

  it('pins the bar to the scroller top once the header has scrolled out', () => {
    expect(placeTableBar({ top: -200, headerBottom: -160 }, { top: 100 }, bar)).toBe(100)
  })
})

describe('the table bar tooltip', () => {
  const mode = new Compartment()
  const shown = (state: EditorState) =>
    state.facet(showTooltip).filter((t): t is Tooltip => t !== null)

  function inMode(on: boolean) {
    const state = EditorState.create({
      doc: DOC,
      selection: EditorSelection.cursor(rowStart + 4),
      extensions: [noteMarkdown, tableToolbar, mode.of(writeActive.of(on))],
    })
    return state.update({ effects: setToolbarFocus.of(true) }).state
  }

  const switchTo = (state: EditorState, on: boolean) =>
    state.update({ effects: mode.reconfigure(writeActive.of(on)) }).state

  it('sits above the table in Write mode and at the caret row in Edit mode', () => {
    expect(shown(inMode(true))[0]).toMatchObject({ pos: DOC.indexOf('| a'), strictSide: true })
    expect(shown(inMode(false))[0]).toMatchObject({ pos: rowStart })
  })

  it('changes placement when the mode switches, with the caret where it was', () => {
    const edit = inMode(false)
    const write = switchTo(edit, true)
    expect(write.selection.main.head).toBe(edit.selection.main.head)
    expect(shown(write)[0]).toMatchObject({ pos: DOC.indexOf('| a'), strictSide: true })
    expect(shown(switchTo(write, false))[0]).toMatchObject({ pos: rowStart })
  })
})
