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
    const after = composing.update({}).state
    expect(blocks(after)).toEqual([`0-${fenceEnd + 1} title, tags`])
  })

  it('is no block in a note without front matter, or with a fence that is not closed', () => {
    expect(blocks(stateOf('Body'))).toEqual([])
    expect(blocks(stateOf('---\ntitle: x\nBody'))).toEqual([])
  })
})
