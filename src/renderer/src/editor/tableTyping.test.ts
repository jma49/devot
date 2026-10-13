import {
  autocompletion,
  closeCompletion,
  completionStatus,
  startCompletion,
} from '@codemirror/autocomplete'
import { history, undo } from '@codemirror/commands'
import {
  EditorSelection,
  EditorState,
  StateEffect,
  type Extension,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { ViewPlugin, type EditorView, type PluginValue } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import { TABLE_COMMANDS } from './tableCommands'
import { tableInput, tableTyping, typeInTable } from './tableTyping'

// Typing a table row by hand: documents mark the cursor with `^`.
function state(marked: string, extra = [history()]) {
  const at = marked.indexOf('^')
  return EditorState.create({
    doc: marked.replace('^', ''),
    selection: EditorSelection.cursor(at < 0 ? 0 : at),
    extensions: [noteMarkdown, tableTyping(), ...extra],
  })
}

function show(s: EditorState): string {
  const head = s.selection.main.head
  const text = s.doc.toString()
  return text.slice(0, head) + '^' + text.slice(head)
}

const lines = (...l: string[]) => l.join('\n')

/** Types `text` a character at a time, as the editor's input handlers see it. */
function type(s: EditorState, text: string): EditorState {
  for (const ch of text) {
    const { head } = s.selection.main
    const spec = typeInTable(s, head, head, ch)
    s = spec
      ? s.update(spec).state
      : s.update({
          changes: { from: head, insert: ch },
          selection: EditorSelection.cursor(head + ch.length),
          userEvent: 'input.type',
        }).state
  }
  return s
}

/** The table's Return key (the command it runs in a table). */
function enter(s: EditorState): EditorState {
  const spec = TABLE_COMMANDS.nextRow(s)
  expect(spec).not.toBeNull()
  return s.update(spec!).state
}

const moveTo = (s: EditorState, pos: number) =>
  s.update({ selection: EditorSelection.cursor(pos), userEvent: 'select' }).state

const HEADER = lines('| a | b |', '|-|-|^')

describe('typing a row by hand after Return', () => {
  it('turns `| 1 | 2 |` into a row with cells 1 and 2', () => {
    let s = enter(state(HEADER))
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| ^    |     |'))
    s = type(s, '| 1 | 2 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |^'))
  })

  it('types a whole table: rows, Return after each, Return on the empty row to leave', () => {
    let s = state('^')
    s = type(s, '| a | b |')
    s = s.update({
      changes: { from: s.doc.length, insert: '\n' },
      selection: EditorSelection.cursor(s.doc.length + 1),
    }).state
    s = type(s, '|-|-|')
    s = type(enter(s), '| 1 | 2 |')
    s = type(enter(s), '| 3 | 4 |')
    s = type(enter(enter(s)), 'after')
    expect(show(s)).toBe(
      lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| 3   | 4   |', '', 'after^'),
    )
  })

  it('formats the table as each pipe ends a cell, widening its column', () => {
    let s = enter(state(HEADER))
    s = type(s, '| hello |')
    expect(show(s)).toBe(lines('| a     | b   |', '| ----- | --- |', '| hello | ^    |'))
    s = type(s, ' wide world |')
    expect(show(s)).toBe(
      lines('| a     | b          |', '| ----- | ---------- |', '| hello | wide world |^'),
    )
  })

  it('takes a row typed without its outer pipes', () => {
    const s = type(enter(state(HEADER)), '1 | 2')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2^    |'))
  })

  it('takes a row typed without outer pipes after a delimiter row without a closing pipe', () => {
    for (const header of [lines('a | b', '--|--^'), lines('| a | b |', '|-|-^')]) {
      const s = type(enter(state(header)), '1 | 2')
      expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2^    |'))
    }
  })

  it('takes the opening pipe after text typed and deleted again, or a stray space', () => {
    let s = type(enter(state(HEADER)), 'x')
    const { head } = s.selection.main
    s = s.update({ changes: { from: head - 1, to: head }, userEvent: 'delete.backward' }).state
    s = type(s, '| 1 | 2 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |^'))
    s = type(enter(state(HEADER)), ' | 1 | 2 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |^'))
  })

  it('leaves a cell empty for a pipe typed in it', () => {
    const s = type(enter(state(HEADER)), '| | 2 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '|     | 2   |^'))
  })

  it('starts the row at its first cell when Return left the cursor in another', () => {
    // Return inside a cell keeps its column.
    let s = enter(state(lines('| a | b |', '|-|-|', '| 1 | 2^ |')))
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '|     | ^    |'))
    s = type(s, '| 3 | 4 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| 3   | 4   |^'))
  })

  it('takes only the first pipe of the row as its opening pipe', () => {
    // An extra space typed after the opening pipe.
    let s = type(enter(state(HEADER)), '|  | 2 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '|     | 2   |^'))
    // A letter typed in the second cell and deleted again.
    s = type(enter(state(HEADER)), '| | a')
    const { head } = s.selection.main
    s = s.update({ changes: { from: head - 1, to: head }, userEvent: 'delete.backward' }).state
    s = type(s, '|')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '|     |     |^'))
  })

  it('takes an opening pipe again after undo empties the row', () => {
    let s = type(enter(state(HEADER)), '| 1 |')
    undo({ state: s, dispatch: (tr: Transaction) => (s = tr.state) })
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| ^    |     |'))
    s = type(s, '| 3 | 4 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 3   | 4   |^'))
  })

  it('keeps typing the row when the note changes elsewhere', () => {
    // As a change from another window arrives: no user event.
    let s = type(enter(state(HEADER)), '| 1 |')
    s = s.update({ changes: { from: 0, insert: 'intro\n\n' } }).state
    // The space after the pipe is still padding.
    s = type(s, ' 2')
    expect(show(s)).toBe(lines('intro', '', '| a   | b   |', '| --- | --- |', '| 1   | 2^    |'))
    s = type(s, ' |')
    expect(show(s)).toBe(lines('intro', '', '| a   | b   |', '| --- | --- |', '| 1   | 2   |^'))
  })

  it('keeps the quote markers of a table in a quote', () => {
    const s = type(enter(state(lines('> | a | b |', '> |-|-|^'))), '| 1 | 2 |')
    expect(show(s)).toBe(lines('> | a   | b   |', '> | --- | --- |', '> | 1   | 2   |^'))
  })

  it('works on rows Tab or Option+Return made too', () => {
    let s = state(lines('| a | b |', '|-|-|', '| 1 | 2^ |'))
    s = s.update(TABLE_COMMANDS.nextCell(s)!).state
    s = type(s, '| 3 | 4 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| 3   | 4   |^'))
    s = state(lines('| a | b |', '|-|-|', '| ^1 | 2 |'))
    s = s.update(TABLE_COMMANDS.insertRowBelow(s)!).state
    s = type(s, '| 3 | 4 |')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '| 3   | 4   |^'))
  })
})

describe('pipes that stay text', () => {
  it('keeps an escaped pipe in its cell', () => {
    const s = type(enter(state(HEADER)), '| x \\| y | z |')
    expect(show(s)).toBe(lines('| a      | b   |', '| ------ | --- |', '| x \\| y | z   |^'))
  })

  it('keeps a pipe typed inside a cell text', () => {
    let s = type(enter(state(HEADER)), '| ab')
    s = moveTo(s, s.selection.main.head - 1)
    s = type(s, '|')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| a|^b    |     |'))
  })

  it('types a pipe after the row closing pipe as written', () => {
    const s = type(enter(state(HEADER)), '| 1 | 2 ||')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   | 2   ||^'))
  })

  it('leaves an empty row other table commands left the cursor in alone', () => {
    let s = state(lines('| a | b |', '|-|-|', '| 1 | 2 |', '|  | ^ |'))
    s = s.update(TABLE_COMMANDS.format(s)!).state
    expect(show(type(s, '|'))).toBe(
      lines('| a   | b   |', '| --- | --- |', '| 1   | 2   |', '|     | |^    |'),
    )
  })

  it('leaves rows the cursor was not brought to by a table key alone', () => {
    // An existing row: the pipe is text, as anywhere else.
    const doc = lines('| a | b |', '|-|-|', '| 1 ^|  |')
    expect(typeInTable(state(doc), doc.indexOf('^'), doc.indexOf('^'), '|')).toBeNull()
    expect(show(type(state(doc), '|'))).toBe(lines('| a | b |', '|-|-|', '| 1 |^|  |'))
    // Outside a table.
    expect(typeInTable(state('plain^'), 5, 5, '|')).toBeNull()
  })

  it('stops once the cursor leaves the row', () => {
    let s = enter(state(HEADER))
    const row = s.selection.main.head
    s = moveTo(s, 2)
    s = moveTo(s, row)
    expect(show(type(s, '|'))).toBe(lines('| a   | b   |', '| --- | --- |', '| |^    |     |'))
  })

  it('types a space as written unless it pads a cell the cursor just moved to', () => {
    let s = type(enter(state(HEADER)), '1  ')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1  ^    |     |'))
    s = type(s, '|  2')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| 1   |  2^    |'))
    // Only right after the pipe: once text is typed, a space is text.
    s = type(enter(state(HEADER)), '|x y')
    expect(show(s)).toBe(lines('| a   | b   |', '| --- | --- |', '| x y^    |     |'))
  })

  it('handles only a single typed pipe or space at the cursor', () => {
    const s = enter(state(HEADER))
    const { head } = s.selection.main
    expect(typeInTable(s, head, head, '||')).toBeNull()
    expect(typeInTable(s, head, head, 'x')).toBeNull()
    expect(typeInTable(s, head - 1, head, '|')).toBeNull()
  })
})

describe('the input handler', () => {
  const view = (s: EditorState, composing = false) => {
    const dispatched: EditorState[] = []
    const v = {
      state: s,
      composing,
      compositionStarted: composing,
      dispatch: (spec: Parameters<EditorState['update']>[0]) =>
        dispatched.push(s.update(spec).state),
    }
    return { v: v as unknown as EditorView, dispatched }
  }

  it('takes a typed pipe in a new row', () => {
    const s = enter(state(HEADER))
    const { head } = s.selection.main
    const typed = view(s)
    expect(tableInput(typed.v, head, head, '|')).toBe(true)
    expect(typed.dispatched).toHaveLength(1)
  })

  it('leaves input while an input method composes to the editor', () => {
    const s = enter(state(HEADER))
    const { head } = s.selection.main
    const composing = view(s, true)
    expect(tableInput(composing.v, head, head, '|')).toBe(false)
    expect(composing.dispatched).toEqual([])
  })

  it('leaves input in a read-only editor to the editor', () => {
    let s = enter(state(HEADER))
    s = s.update({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) }).state
    const { head } = s.selection.main
    const readOnly = view(s)
    expect(tableInput(readOnly.v, head, head, '|')).toBe(false)
    expect(readOnly.dispatched).toEqual([])
  })
})

describe('the completion list', () => {
  /**
   * `s` with its completion list open on the source's options, as the view's
   * completion plugin opens it: the plugin runs on a stand-in view (state
   * and dispatch are all it uses) and answers the query it was started with.
   */
  function standIn(s: EditorState) {
    const v = {
      get state() {
        return s
      },
      dispatch: (spec: TransactionSpec) => (s = s.update(spec).state),
    }
    return v as unknown as EditorView
  }

  async function openCompletion(v: EditorView, extension: Extension[]) {
    expect(startCompletion(v)).toBe(true)
    const plugin = extension.find((e) => e instanceof ViewPlugin)
    ;(plugin as unknown as { create(view: EditorView): PluginValue }).create(v)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('leaves a pipe typed while the list is open to the editor', async () => {
    const completion = autocompletion({
      override: [(context) => ({ from: context.pos, options: [{ label: 'word' }] })],
    }) as Extension[]
    const v = standIn(type(enter(state(HEADER, [history(), completion])), '| 1'))
    await openCompletion(v, completion)
    expect(completionStatus(v.state)).toBe('active')
    const { head } = v.state.selection.main
    expect(typeInTable(v.state, head, head, '|')).toBeNull()
    // Once the list is closed, the same pipe ends the cell.
    closeCompletion(v)
    expect(completionStatus(v.state)).toBeNull()
    expect(typeInTable(v.state, head, head, '|')).not.toBeNull()
  })
})

describe('undo', () => {
  it('undoes a cell typed with its pipe in one step, then the Return', () => {
    const before = state(HEADER)
    const entered = enter(before)
    let s = type(entered, '| 1 | 2 |')
    const steps: string[] = []
    for (let i = 0; i < 3; i++) {
      undo({ state: s, dispatch: (tr: Transaction) => (s = tr.state) })
      steps.push(show(s))
    }
    expect(steps).toEqual([
      lines('| a   | b   |', '| --- | --- |', '| 1   | ^    |'),
      show(entered),
      show(before),
    ])
  })

  it('changes only padding around the cursor for a pipe, never the cell border', () => {
    const s = type(enter(state(HEADER)), '| 1 ')
    const { head } = s.selection.main
    const tr = s.update(typeInTable(s, head, head, '|')!)
    const changed: [number, number, string][] = []
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
      changed.push([fromA, toA, inserted.toString()]),
    )
    expect(changed).toEqual([[head, head + 2, '']])
  })
})
