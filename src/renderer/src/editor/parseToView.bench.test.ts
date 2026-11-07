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

/**
 * The parser's last step, warmed up: it builds the note's tree and finds the fenced code in it in one go,
 * so no slicing splits it (about 15 ms a megabyte; CodeMirror's own worker pays it too).
 */
function lastStepMs(doc: string): number {
  const last = () => {
    const parse = noteMarkdown.language.parser.startParse(doc)
    for (;;) {
      const start = performance.now()
      if (parse.advance()) return performance.now() - start
    }
  }
  last()
  return last()
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

/** A note open at its end, parsed whole before it was shown. */
async function openedParsed(doc: string): Promise<EditorView> {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [noteMarkdown, parseToView] }),
    parent: document.body,
  })
  views.push(view)
  ensureSyntaxTree(view.state, doc.length, 1e9)
  view.dispatch({ selection: EditorSelection.cursor(doc.length), scrollIntoView: true })
  expect(syntaxTree(view.state).length).toBe(doc.length)
  await pause(800)
  return view
}

function typeAtEnd(view: EditorView): number {
  const at = view.state.doc.length
  const start = performance.now()
  view.dispatch({
    changes: { from: at, insert: 'a' },
    selection: EditorSelection.cursor(at + 1),
  })
  return performance.now() - start
}

const median = (times: number[]) => [...times].sort((a, b) => a - b)[times.length >> 1] ?? 0

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

  it.for<[string, number]>([
    ['1 MB', 1_000_000],
    ['4 MB', 4_000_000],
  ])(
    'holds a %s note no longer than a short slice at a time while the parser catches up, beyond its last step',
    { timeout: 60_000 },
    async ([label, size], context) => {
      const doc = richNote(size)
      const lastStep = lastStepMs(doc)
      const view = await opened(doc)
      const start = performance.now()
      jumpToEnd(view)
      let last = performance.now()
      let held = 0
      while (performance.now() - start < 2_500) {
        await pause(1)
        const now = performance.now()
        held = Math.max(held, now - last)
        last = now
      }
      expect(styled(view)).toBe(true)
      console.log(
        `${label}: longest hold ${held.toFixed(1)} ms, the parser's last step ${lastStep.toFixed(1)} ms`,
      )
      expectWithinBudget(context, held, 40 + lastStep)
    },
  )

  it('leaves keys at the end, once caught up, costing what they do in a note parsed whole', async (context) => {
    const doc = richNote(4_000_000)
    const jumped = await opened(doc)
    jumpToEnd(jumped)
    const start = performance.now()
    while (syntaxTree(jumped.state).length < doc.length && performance.now() - start < 30_000)
      await pause(10)
    await pause(300)
    const parsed = await openedParsed(doc)
    const afterJump: number[] = []
    const whole: number[] = []
    for (let key = 0; key < 8; key++) {
      afterJump.push(typeAtEnd(jumped))
      await pause(150)
      whole.push(typeAtEnd(parsed))
      await pause(150)
    }
    const show = (times: number[]) => times.map((ms) => ms.toFixed(0)).join(' ')
    console.log(
      `4 MB keys at the end: after a jump ${show(afterJump)}, parsed whole ${show(whole)} ms`,
    )
    expectWithinBudget(context, median(afterJump), 1.5 * median(whole) + 10, { exact: true })
  }, 120_000)
})
