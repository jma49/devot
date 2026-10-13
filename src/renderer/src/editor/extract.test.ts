import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { moveSelection, selectedText, trackExtract, type ExtractView } from './extract'
import { noteMarkdown } from './markdown'

/** A stand-in for the editor view: its state, and dispatch. */
function viewOf(doc: string, from: number, to: number) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
    extensions: [history(), trackExtract, noteMarkdown],
  })
  const view: ExtractView & { dispatch(tr: Transaction): void } = {
    get state() {
      return state
    },
    dispatch: (spec: TransactionSpec | Transaction) => {
      state = spec instanceof Transaction ? spec.state : state.update(spec).state
    },
  }
  return view
}

/** A promise settled from outside, to edit the note while a note is being made. */
function later<T>() {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => (settle = resolve))
  return { promise, settle }
}

describe('selectedText', () => {
  it('is the main selection, unless it is empty or blank', () => {
    expect(selectedText(viewOf('Hello world', 6, 11).state)).toBe('world')
    expect(selectedText(viewOf('Hello world', 3, 3).state)).toBeNull()
    expect(selectedText(viewOf('a  \n  b', 1, 5).state)).toBeNull()
  })

  it('is null for a selection that cuts into code or front matter', () => {
    const code = 'Text\n```\ncode\n```\nMore'
    expect(
      selectedText(viewOf(code, code.indexOf('code'), code.indexOf('code') + 4).state),
    ).toBeNull()
    expect(selectedText(viewOf(code, 0, code.indexOf('code')).state)).toBeNull()
    // The whole block may go.
    expect(selectedText(viewOf(code, 5, code.indexOf('\nMore')).state)).toBe('```\ncode\n```')
    const front = '---\ntitle: x\n---\nBody'
    expect(selectedText(viewOf(front, 4, 12).state)).toBeNull()
    expect(selectedText(viewOf(front, front.indexOf('Body'), front.length).state)).toBe('Body')
  })
})

describe('moveSelection', () => {
  it('replaces the selection with what `make` returns, cursor after it', async () => {
    const view = viewOf('Intro\nMove me\nOutro', 6, 13)
    const seen: string[] = []
    const moved = await moveSelection(view, async (text) => {
      seen.push(text)
      return '[Move me](devot://note/x)'
    })
    expect(moved).toBe(true)
    expect(seen).toEqual(['Move me'])
    expect(view.state.doc.toString()).toBe('Intro\n[Move me](devot://note/x)\nOutro')
    expect(view.state.selection.main.head).toBe(6 + '[Move me](devot://note/x)'.length)
  })

  it('is one undo step that brings the text back', async () => {
    const view = viewOf('Keep. Move me.', 6, 14)
    await moveSelection(view, async () => '[Move me.](devot://note/x)')
    undo({ state: view.state, dispatch: (tr) => view.dispatch(tr) })
    expect(view.state.doc.toString()).toBe('Keep. Move me.')
  })

  it('follows edits made while the note is made', async () => {
    const view = viewOf('Intro\nMove me\nOutro', 6, 13)
    const made = later<string | null>()
    const moving = moveSelection(view, () => made.promise)
    view.dispatch({ changes: { from: 0, insert: 'New first line\n' } })
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nEnd' } })
    made.settle('[Move me](devot://note/x)')
    expect(await moving).toBe(true)
    expect(view.state.doc.toString()).toBe(
      'New first line\nIntro\n[Move me](devot://note/x)\nOutro\nEnd',
    )
  })

  it('leaves the note alone when the selected text was changed meanwhile', async () => {
    const view = viewOf('Intro\nMove me\nOutro', 6, 13)
    const made = later<string | null>()
    const moving = moveSelection(view, () => made.promise)
    view.dispatch({ changes: { from: 8, insert: 'X' } })
    made.settle('[Move me](devot://note/x)')
    expect(await moving).toBe(false)
    expect(view.state.doc.toString()).toBe('Intro\nMoXve me\nOutro')
  })

  it('keeps the range through edits just before and after it', async () => {
    const view = viewOf('a foo b', 2, 5)
    const made = later<string | null>()
    const moving = moveSelection(view, () => made.promise)
    view.dispatch({
      changes: [
        { from: 2, insert: '[' },
        { from: 5, insert: ']' },
      ],
    })
    made.settle('link')
    expect(await moving).toBe(true)
    expect(view.state.doc.toString()).toBe('a [link] b')
  })

  it('leaves the note alone once the editor is gone', async () => {
    const view = viewOf('Move me', 0, 7)
    let open = true
    const moving = moveSelection(
      view,
      async () => {
        open = false
        return 'link'
      },
      () => open,
    )
    expect(await moving).toBe(false)
    expect(view.state.doc.toString()).toBe('Move me')
  })

  it('leaves the note alone when no note was made', async () => {
    const view = viewOf('Move me', 0, 7)
    expect(await moveSelection(view, async () => null)).toBe(false)
    expect(await moveSelection(view, () => Promise.reject(new Error('E_TEST')))).toBe(false)
    expect(view.state.doc.toString()).toBe('Move me')
  })

  it('does nothing without selected text, or while another move is under way', async () => {
    let calls = 0
    const make = async () => {
      calls++
      return 'link'
    }
    expect(await moveSelection(viewOf('Text', 2, 2), make)).toBe(false)
    const view = viewOf('Move me', 0, 7)
    const first = later<string | null>()
    const moving = moveSelection(view, () => first.promise)
    expect(await moveSelection(view, make)).toBe(false)
    expect(calls).toBe(0)
    first.settle('[Move me](devot://note/x)')
    expect(await moving).toBe(true)
  })
})
