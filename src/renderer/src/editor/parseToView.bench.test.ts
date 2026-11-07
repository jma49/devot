// @vitest-environment happy-dom
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { noteMarkdown } from './markdown'
import { parseToView } from './parseToView'

const SECTION = [
  '## Week',
  '',
  'A paragraph of prose, as notes mostly have, with **bold**, a [link](https://example.com) and `code`.',
  '',
  '| Day | Done | Notes |',
  '| --- | :--: | ----- |',
  '| Mon | yes | `ok` |',
  '| Tue | no | late |',
  '',
  '$$',
  'e^{i\\pi} + 1 = 0',
  '$$',
  '',
  '![chart](https://example.com/chart.png)',
  '',
  '> A quote with _emphasis_.',
  '',
  '- a task list',
  '- [ ] with a task',
  '',
].join('\n')

function richNote(size: number): string {
  let doc = ''
  while (doc.length < size) doc += SECTION
  return doc
}

/** A whole parse of the note, warmed up: the least any way of reaching its end can take. */
function parseMs(doc: string): number {
  const parse = () =>
    ensureSyntaxTree(EditorState.create({ doc, extensions: [noteMarkdown] }), doc.length, 1e9)
  parse()
  const start = performance.now()
  parse()
  return performance.now() - start
}

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((view) => view.destroy()))

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A note open at its top, once CodeMirror's parser has gone as far ahead as it goes. */
async function opened(doc: string): Promise<EditorView> {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [noteMarkdown, parseToView] }),
    parent: document.body,
  })
  views.push(view)
  await pause(800)
  return view
}

const styled = (view: EditorView) => syntaxTree(view.state).length >= view.viewport.to

function jumpToEnd(view: EditorView): void {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), scrollIntoView: true })
  expect(styled(view)).toBe(false)
}

describe('a jump to the end of a long note the parser has not reached', () => {
  it('is styled in little more than the time a parse of the whole note takes', async (context) => {
    const doc = richNote(2_000_000)
    const parse = parseMs(doc)
    const view = await opened(doc)
    const start = performance.now()
    jumpToEnd(view)
    while (!styled(view) && performance.now() - start < 30_000) await pause(4)
    const styledMs = performance.now() - start
    console.log(`2 MB: parse ${parse.toFixed(0)} ms, styled after ${styledMs.toFixed(0)} ms`)
    expectWithinBudget(context, styledMs, 2 * parse + 100)
  }, 60_000)

  it('holds the editor no longer than a short slice at a time while the parser catches up', async (context) => {
    const doc = richNote(1_000_000)
    parseMs(doc)
    const view = await opened(doc)
    const start = performance.now()
    jumpToEnd(view)
    let last = performance.now()
    let held = 0
    while (performance.now() - start < 1_500) {
      await pause(1)
      const now = performance.now()
      held = Math.max(held, now - last)
      last = now
    }
    expect(styled(view)).toBe(true)
    console.log(`1 MB: longest hold ${held.toFixed(1)} ms`)
    expectWithinBudget(context, held, 40)
  }, 60_000)
})
