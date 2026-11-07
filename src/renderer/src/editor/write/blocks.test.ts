import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  EditorState,
  type Extension,
  type Range,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, type Decoration, type DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import {
  randomChange,
  randomNote,
  seeded,
  type Random,
} from '../../../../../tests/support/random-notes'
import { noteMarkdown } from '../markdown'
import { drawnBlocks, writeBlocks } from './blocks'
import { setWriteFocus, writeFocus, writeFocusTracking } from './focus'
import { writeMode } from './index'
import { writeTables } from './tableGrid'

const NOTE = '---\ntitle: Plan\ntags: [a, b]\n# not a key\n---\nBody **text**'

function stateOf(doc: string, caret = doc.length, extra: Extension = []): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [noteMarkdown, writeFocusTracking, writeBlocks, extra],
  })
  ensureSyntaxTree(state, doc.length, 1e9)
  return state.update({}).state
}

/** The block ranges as `from-to` and the folded row's keys. */
function blocks(state: EditorState): string[] {
  const out: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    ;(source as DecorationSet).between(0, state.doc.length, (from, to, deco) => {
      const keys = (deco.spec.widget as { keys?: string } | undefined)?.keys
      out.push(`${from}-${to} ${keys ?? ''}`)
    })
  }
  return out
}

const fenceEnd = NOTE.indexOf('---', 4) + 3

describe('front matter in Write mode', () => {
  it('folds to one row naming its keys while the caret is below it', () => {
    expect(blocks(stateOf(NOTE))).toEqual([`0-${fenceEnd} title, tags`])
  })

  it('opens while the caret is on one of its lines and the editor has the keyboard', () => {
    const state = stateOf(NOTE, 8)
    expect(blocks(state)).toEqual([`0-${fenceEnd} title, tags`])
    const focused = state.update({ effects: setWriteFocus.of(true) }).state
    expect(blocks(focused)).toEqual([])
    const below = focused.update({ selection: { anchor: NOTE.length } }).state
    expect(blocks(below)).toEqual([`0-${fenceEnd} title, tags`])
  })

  it('opens for a selection that reaches into it, focused or not', () => {
    const state = stateOf(NOTE).update({ selection: { anchor: 2, head: NOTE.length } }).state
    expect(blocks(state)).toEqual([])
  })

  it('is left alone while an input method composes, and caught up after', () => {
    const open = stateOf(NOTE, 8).update({ effects: setWriteFocus.of(true) }).state
    const composing = open.update({
      changes: { from: NOTE.indexOf('Plan'), insert: 'x' },
      selection: { anchor: NOTE.length + 1 },
      userEvent: 'input.type.compose',
    }).state
    expect(blocks(composing)).toEqual([])
    // A change from elsewhere (the parser, a sync) may come inside the same composition.
    const parsed = composing.update({}).state
    expect(blocks(parsed)).toEqual([])
    const after = parsed.update({
      selection: { anchor: NOTE.length + 1 },
      userEvent: 'select',
    }).state
    expect(blocks(after)).toEqual([`0-${fenceEnd + 1} title, tags`])
  })

  it('is no block in a note without front matter, or with a fence that is not closed', () => {
    expect(blocks(stateOf('Body'))).toEqual([])
    expect(blocks(stateOf('---\ntitle: x\nBody'))).toEqual([])
  })
})

describe('rendered blocks in Write mode', () => {
  const IMAGE = '![Plan](https://example.com/plan.png)'
  const doc = `Top\n${IMAGE}\n\n$$\nx^2\n$$\nEnd`
  const math = doc.indexOf('$$')

  /** Each block decoration as `from-to kind look`; an open one is a point under its source. */
  function rendered(state: EditorState): string[] {
    const out: string[] = []
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === 'function') continue
      ;(source as DecorationSet).between(0, state.doc.length, (from, to, deco) => {
        const widget = deco.spec.widget as { block?: { kind: string }; look?: string } | undefined
        if (widget?.block) out.push(`${from}-${to} ${widget.block.kind} ${widget.look}`)
      })
    }
    return out
  }

  it('take their lines while closed', () => {
    expect(rendered(stateOf(doc, 0))).toEqual([
      `4-${4 + IMAGE.length} image closed`,
      `${math}-${math + 9} math closed`,
    ])
  })

  it('show their source with the rendering under it while the caret is in them, focused', () => {
    const state = stateOf(doc, math + 4).update({ effects: setWriteFocus.of(true) }).state
    expect(rendered(state)).toEqual([
      `4-${4 + IMAGE.length} image closed`,
      `${math + 9}-${math + 9} math open`,
    ])
  })

  it('open for a caret at the start or end of their source', () => {
    const focus = { effects: setWriteFocus.of(true) }
    const start = stateOf(doc, 4).update(focus).state
    expect(rendered(start)[0]).toBe(`${4 + IMAGE.length}-${4 + IMAGE.length} image open`)
    const end = stateOf(doc, math + 9).update(focus).state
    expect(rendered(end)[1]).toBe(`${math + 9}-${math + 9} math open`)
  })

  it('show a selection over them whole', () => {
    const state = stateOf(doc).update({ selection: { anchor: 4, head: 4 + IMAGE.length } }).state
    expect(rendered(state)[0]).toBe(`4-${4 + IMAGE.length} image selected`)
  })
})

describe('the blocks after a step', () => {
  const extensions = [
    noteMarkdown,
    writeFocusTracking,
    writeBlocks,
    writeTables,
    EditorState.allowMultipleSelections.of(true),
  ]

  /** Every decoration the blocks give the editor, in order. */
  function drawn(state: EditorState): Range<Decoration>[] {
    const out: Range<Decoration>[] = []
    const { decorations, outer } = drawnBlocks(state)
    for (const source of [...decorations, outer])
      for (let i = source.iter(); i.value; i.next()) out.push(i.value.range(i.from, i.to))
    return out
  }

  /** The note, its selection and its focus drawn from nothing. */
  function fresh(state: EditorState): EditorState {
    const doc = state.doc.toString()
    const start = EditorState.create({
      doc,
      selection: state.selection,
      extensions,
    })
    ensureSyntaxTree(start, doc.length, 1e9)
    return start.update({ effects: setWriteFocus.of(state.field(writeFocus)) }).state
  }

  function randomStep(next: Random, state: EditorState): TransactionSpec {
    const length = state.doc.length
    const at = () => Math.floor(next() * (length + 1))
    const kind = next()
    if (kind < 0.4) {
      const change = randomChange(next, state.doc.toString())
      const end = change.from + change.insert.length
      return {
        changes: change,
        selection: { anchor: end },
        ...(next() < 0.7 ? { userEvent: 'input.type' } : {}),
      }
    }
    if (kind < 0.55) return { effects: setWriteFocus.of(next() < 0.7) }
    const ranges = [EditorSelection.range(at(), next() < 0.6 ? at() : at())]
    if (kind < 0.65) ranges.push(EditorSelection.cursor(at()))
    if (kind > 0.85) ranges[0] = EditorSelection.cursor(ranges[0]!.head)
    return { selection: EditorSelection.create(ranges), userEvent: 'select' }
  }

  it('are what drawing the note from nothing gives', () => {
    const next = seeded(3)
    for (let note = 0; note < 40; note++) {
      let state = fresh(EditorState.create({ doc: randomNote(next), extensions }))
      for (let i = 0; i < 25; i++) {
        state = state.update(randomStep(next, state)).state
        if (next() < 0.5) {
          ensureSyntaxTree(state, state.doc.length, 1e9)
          state = state.update({}).state
        }
        // The parser reading an edit can tell some notes apart from reading them anew
        // (a table's rows); the blocks follow the tree the editor has.
        const anew = fresh(state)
        if (syntaxTree(state).toString() !== syntaxTree(anew).toString()) continue
        const expected = drawn(anew)
        const actual = drawn(state)
        const where = { doc: state.doc.toString(), selection: state.selection.toJSON() }
        expect({ ...where, at: actual.map((r) => `${r.from}-${r.to}`) }).toEqual({
          ...where,
          at: expected.map((r) => `${r.from}-${r.to}`),
        })
        const same = actual.map((r, k) => r.value.eq(expected[k]!.value))
        expect({ ...where, same }).toEqual({ ...where, same: same.map(() => true) })
      }
    }
  })
})

describe('the decorations Write mode keeps in its state', () => {
  // CodeMirror compares every decoration from state on every update, but only
  // these change the lines' heights and must come from state.
  const takesLines = (state: EditorState, from: number, to: number, value: Decoration) =>
    value.spec.block === true || (value.point && to > state.doc.lineAt(from).to)

  it('are only those that take or join lines', () => {
    const doc = [
      '---',
      'title: Plan',
      '---',
      'Text with **bold**.',
      '',
      '| a | b | c |',
      '| - | :-: | - |',
      '| 1 |',
      '| 2 | | 3 |',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '![chart](https://example.com/chart.png)',
      '',
      'End',
    ].join('\n')
    const state = stateOf(doc, doc.indexOf('bold'), [writeMode()])
    const kept: string[] = []
    const others: string[] = []
    for (const facet of [EditorView.decorations, EditorView.outerDecorations]) {
      for (const source of state.facet(facet)) {
        if (typeof source === 'function') continue
        ;(source as DecorationSet).between(0, state.doc.length, (from, to, value) => {
          ;(takesLines(state, from, to, value) ? kept : others).push(`${from}-${to}`)
        })
      }
    }
    expect(kept.length).toBeGreaterThanOrEqual(4)
    expect(others).toEqual([])
  })
})
