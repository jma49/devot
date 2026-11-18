// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { previewDecorations, reviewPreview, setReviewPreview } from './reviewPreview'

const spans = (set: ReturnType<typeof previewDecorations>) => {
  const out: { from: number; to: number; point: boolean }[] = []
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    out.push({ from, to, point: value.spec.widget !== undefined })
  })
  return out
}

describe('the Undo preview marks', () => {
  it('tints inserted text and marks a deletion point, inside the text there is', () => {
    const set = previewDecorations(
      [
        { from: 4, to: 4 },
        { from: 0, to: 3 },
        { from: 8, to: 20 },
        { from: 30, to: 31 },
      ],
      10,
    )
    expect(spans(set)).toEqual([
      { from: 0, to: 3, point: false },
      { from: 4, to: 4, point: true },
      { from: 8, to: 10, point: false },
    ])
  })

  it('follows edits made while it shows, and clears when asked', () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const view = new EditorView({
      state: EditorState.create({ doc: 'abc def', extensions: reviewPreview }),
      parent,
    })
    const tinted = () =>
      [...parent.querySelectorAll('.cm-review-preview')].map((mark) => mark.textContent).join('|')
    view.dispatch({ effects: setReviewPreview.of([{ from: 4, to: 7 }]) })
    expect(tinted()).toBe('def')
    view.dispatch({ changes: { from: 0, insert: 'xx' } })
    expect(tinted()).toBe('def')
    view.dispatch({ effects: setReviewPreview.of([]) })
    expect(tinted()).toBe('')
    view.destroy()
    parent.remove()
  })
})
