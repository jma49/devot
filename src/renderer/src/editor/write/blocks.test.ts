import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from '../markdown'
import { writeBlocks } from './blocks'
import { setWriteFocus, writeFocusTracking } from './focus'

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
