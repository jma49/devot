import { EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { randomChange, randomNote, seeded } from '../../../../../tests/support/random-notes'
import { carryFootnotes, footnoteNumbers } from './footnotes'

const numbers = (doc: string) => Object.fromEntries(footnoteNumbers(Text.of(doc.split('\n'))))

describe('footnote numbers', () => {
  it('count a label with a definition, in the order of its first reference, those in definitions last', () => {
    const doc = 'See[^b] and[^a].\n\n[^a]: First[^c].\n[^b]: Second.\n[^c]: Third.\n\nNone[^x].'
    expect(numbers(doc)).toEqual({ b: 1, a: 2, c: 3 })
  })

  it('leave out references in code and escaped ones', () => {
    const doc = '`[^a]` \\[^a]\n\n```\n[^a]\n```\n\n    [^a]\n\nThen[^b].\n\n[^a]: A.\n[^b]: B.'
    expect(numbers(doc)).toEqual({ b: 1 })
  })
})

describe('footnote numbers after an edit', () => {
  it('are those a reading of the whole note finds, edit after edit', () => {
    const next = seeded(5)
    for (let note = 0; note < 60; note++) {
      let state = EditorState.create({ doc: randomNote(next) })
      footnoteNumbers(state.doc)
      for (let i = 0; i < 20; i++) {
        const tr = state.update({ changes: randomChange(next, state.doc.toString()) })
        carryFootnotes(tr)
        state = tr.state
        const doc = state.doc.toString()
        expect({ doc, numbers: Object.fromEntries(footnoteNumbers(state.doc)) }).toEqual({
          doc,
          numbers: numbers(doc),
        })
      }
    }
  })

  it('are read again only from the edited line until the reading is as before', () => {
    const doc = Array.from({ length: 2000 }, (_, i) => `Line ${i}[^n]`).join('\n') + '\n\n[^n]: N.'
    const state = EditorState.create({ doc })
    const before = footnoteNumbers(state.doc)
    const tr = state.update({ changes: { from: 3, insert: 'x' } })
    carryFootnotes(tr)
    expect(footnoteNumbers(tr.state.doc)).toBe(before)
    const fenced = tr.state.update({ changes: { from: 0, insert: '```\n' } })
    carryFootnotes(fenced)
    expect(Object.fromEntries(footnoteNumbers(fenced.state.doc))).toEqual({})
  })
})
