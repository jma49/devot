// @vitest-environment happy-dom
import { EditorSelection, EditorState, Text, type ChangeSpec } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { findMatches, MAX_FIND_MATCHES, type FindOptions } from '../../../core/find'
import { editorFind, editorFindTarget } from './find'

function editor(doc: string) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [editorFind(), EditorState.allowMultipleSelections.of(true)],
    }),
    parent: document.body,
  })
  return { view, target: editorFindTarget(view) }
}

function marks(view: EditorView) {
  const out: [number, number, string][] = []
  for (const source of view.state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    ;(source as DecorationSet).between(0, view.state.doc.length, (from, to, deco) => {
      out.push([from, to, String(deco.spec.class)])
    })
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]))
}

/** What the find bar shows for this document when searched from scratch. */
function expected(view: EditorView, options: FindOptions) {
  const doc = view.state.doc.toString()
  const result = findMatches(doc, options)
  const { from, to } = view.state.selection.main
  const current = result.matches.findIndex((m) => m.from === from && m.to === to)
  const matched: [number, number, string][] = result.matches.map((m) => [
    m.from,
    m.to,
    'cm-find-match',
  ])
  if (current >= 0 && from < to) matched.push([from, to, 'cm-find-current'])
  return {
    status: {
      total: result.matches.length,
      current: current < 0 ? null : current,
      invalid: result.invalid,
      capped: result.capped,
    },
    marks: matched.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2])),
  }
}

const EMOJI = String.fromCodePoint(0x1f600)
const alphabet = fc.constantFrom('a', 'A', 'b', 'c', EMOJI, '\n', ' ')
const piece = (max: number) => fc.array(alphabet, { maxLength: max }).map((c) => c.join(''))
const change = fc.record({ at: fc.nat({ max: 60 }), remove: fc.nat({ max: 5 }), insert: piece(5) })

describe('editor find', () => {
  it('keeps the matches, the count and the current match as a fresh search gives them', () => {
    fc.assert(
      fc.property(
        piece(60),
        fc.array(fc.constantFrom('a', 'A', 'b', EMOJI, ' '), { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        fc.boolean(),
        fc.array(fc.array(change, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
        (doc, query, caseSensitive, regexp, steps) => {
          const { view, target } = editor(doc)
          const options = { query: query.join(''), regexp, caseSensitive }
          target.search(options)
          target.next()
          for (const step of steps) {
            const length = view.state.doc.length
            // One transaction may change several places, as replacing in a multiple selection does.
            const changes: ChangeSpec[] = []
            let last = 0
            for (const c of [...step].sort((a, b) => a.at - b.at)) {
              const from = Math.max(last, Math.min(c.at, length))
              const to = Math.min(from + c.remove, length)
              changes.push({ from, to, insert: c.insert })
              last = to
            }
            view.dispatch({ changes })
            const want = expected(view, options)
            expect(target.status()).toEqual(want.status)
            expect(marks(view)).toEqual(want.marks)
          }
          view.destroy()
        },
      ),
      { numRuns: 400 },
    )
  })

  it('reads only around a change in a long note', () => {
    const lines = 'A line of prose about a dog.\n'.repeat(9) + 'A line about a cat.\n'
    const { view, target } = editor(lines.repeat(4_000))
    target.search({ query: 'cat', regexp: false, caseSensitive: false })
    let read = 0
    type Slice = (this: Text, from: number, to?: number, lineSep?: string) => string
    const kinds = new Set(
      [Text.of(['a']), view.state.doc].map(
        (doc) => Object.getPrototypeOf(doc) as { sliceString: Slice },
      ),
    )
    const restore = [...kinds].map((kind) => {
      const original = kind.sliceString
      kind.sliceString = function (this: Text, from: number, to = this.length, lineSep?: string) {
        read += to - from
        return original.call(this, from, to, lineSep)
      }
      return () => (kind.sliceString = original)
    })
    const typed = view.state.update({
      changes: { from: view.state.doc.length >> 1, insert: 'x' },
    }).state
    for (const undo of restore) undo()
    expect(read).toBeLessThan(1_000)
    view.setState(typed)
    expect(target.status().total).toBe(4_000)
    view.destroy()
  })

  it('keeps the current match while typing elsewhere', () => {
    const { view, target } = editor('one two one\nthree one')
    target.search({ query: 'one', regexp: false, caseSensitive: false })
    target.next()
    expect(target.status()).toMatchObject({ total: 3, current: 1 })
    view.dispatch({
      changes: { from: 0, insert: 'one ' },
      selection: EditorSelection.range(12, 15),
    })
    expect(target.status()).toMatchObject({ total: 4, current: 2 })
    view.destroy()
  })

  it('caps the matches as a fresh search does when typing adds more', () => {
    const { view, target } = editor('a'.repeat(MAX_FIND_MATCHES - 1))
    target.search({ query: 'a', regexp: false, caseSensitive: false })
    expect(target.status()).toMatchObject({ total: MAX_FIND_MATCHES - 1, capped: false })
    view.dispatch({ changes: { from: 10, insert: 'aa' } })
    expect(target.status()).toMatchObject({ total: MAX_FIND_MATCHES, capped: true })
    expect(marks(view).filter((m) => m[2] === 'cm-find-match')).toHaveLength(MAX_FIND_MATCHES)
    view.dispatch({ changes: { from: 0, to: 3 } })
    expect(target.status()).toMatchObject({ total: MAX_FIND_MATCHES - 2, capped: false })
    view.destroy()
  })
})
