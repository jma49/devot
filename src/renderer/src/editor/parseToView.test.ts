// @vitest-environment happy-dom
import { syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import { parseToView } from './parseToView'

const SECTION =
  '## Part\n\nSome **bold** prose and a [link](https://example.com).\n\n- a list\n- [ ] a task\n\n'

const note = (size: number) => SECTION.repeat(Math.ceil(size / SECTION.length))

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => view.destroy()))

function opened(doc: string, steps: string[] = []): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        noteMarkdown,
        parseToView,
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions)
            if (!tr.docChanged && !tr.selection) steps.push('parse')
        }),
      ],
    }),
    parent: document.body,
  })
  views.push(view)
  return view
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits up to `ms`, well before CodeMirror's own parse worker would start, for `done`. */
async function within(ms: number, done: () => boolean): Promise<boolean> {
  const start = performance.now()
  while (!done() && performance.now() - start < ms) await pause(2)
  return done()
}

const parsedTo = (view: EditorView) => syntaxTree(view.state).length

describe('parsing toward where the view jumped', () => {
  it('styles a part the parser had not reached, then works as far ahead as the parser does, and no further', async () => {
    const doc = note(300_000)
    const view = opened(doc)
    view.dispatch({ selection: EditorSelection.cursor(150_000), scrollIntoView: true })
    expect(parsedTo(view)).toBeLessThan(view.viewport.to)
    expect(await within(400, () => parsedTo(view) >= view.viewport.to + 100_000)).toBe(true)
    await pause(20)
    expect(parsedTo(view)).toBeLessThan(doc.length)
  })

  it('follows the view when it jumps again before the parse got there', async () => {
    const doc = note(300_000)
    const view = opened(doc)
    view.dispatch({ selection: EditorSelection.cursor(120_000), scrollIntoView: true })
    view.dispatch({ selection: EditorSelection.cursor(doc.length), scrollIntoView: true })
    expect(await within(400, () => parsedTo(view) === doc.length)).toBe(true)
  })

  it('leaves a note alone while its view is parsed', async () => {
    const steps: string[] = []
    const view = opened(note(2_500), steps)
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.length),
      scrollIntoView: true,
    })
    await pause(20)
    expect(steps).toEqual([])
  })

  it('stops when the editor closes', async () => {
    const steps: string[] = []
    const view = opened(note(300_000), steps)
    view.dispatch({ selection: EditorSelection.cursor(250_000), scrollIntoView: true })
    view.destroy()
    await pause(40)
    expect(steps).toEqual([])
  })
})
