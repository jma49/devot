// @vitest-environment happy-dom
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteMarkdown } from './markdown'
import { parseToView } from './parseToView'

vi.mock('@codemirror/language', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/language')>()
  return {
    ...actual,
    ensureSyntaxTree: vi.fn<typeof actual.ensureSyntaxTree>(actual.ensureSyntaxTree),
  }
})

const slices = vi.mocked(ensureSyntaxTree)

const SECTION =
  '## Part\n\nSome **bold** prose and a [link](https://example.com).\n\n- a list\n- [ ] a task\n\n'

const note = (size: number) => SECTION.repeat(Math.ceil(size / SECTION.length))

const views: EditorView[] = []
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
  vi.useRealTimers()
  slices.mockClear()
})

function opened(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [noteMarkdown, parseToView] }),
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

  it('leaves a note alone while its view is parsed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const view = opened(note(2_500))
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.length),
      scrollIntoView: true,
    })
    vi.advanceTimersByTime(1_000)
    expect(slices).not.toHaveBeenCalled()
  })

  it('stops when the editor closes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const view = opened(note(300_000))
    view.dispatch({ selection: EditorSelection.cursor(250_000), scrollIntoView: true })
    for (let timer = 0; timer < 10 && slices.mock.calls.length === 0; timer++)
      vi.advanceTimersToNextTimer()
    expect(slices).toHaveBeenCalledOnce()
    view.destroy()
    vi.advanceTimersByTime(1_000)
    expect(slices).toHaveBeenCalledOnce()
  })

  it('parses on only once keys have paused for 100 ms', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const view = opened(note(1_000_000))
    const type = () => view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' } })
    view.dispatch({
      selection: EditorSelection.cursor(view.state.doc.length),
      scrollIntoView: true,
    })
    type()
    vi.advanceTimersByTime(50)
    type()
    vi.advanceTimersByTime(90)
    expect(slices).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20)
    expect(slices).toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(syntaxTree(view.state).length).toBeGreaterThanOrEqual(view.viewport.to)
  })
})
