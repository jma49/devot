// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { noteMarkdown } from './markdown'
import { writeFocusTracking } from './write/focus'
import { writeMode } from './write/index'

// One frame at 60 Hz: the iPhone's editor screen swaps each note it shows into one view
// (docs/specs/performance.md, switching notes).
const SWITCH_MS = 16

const SECTION = [
  '## Week',
  '',
  'A paragraph of prose, as notes mostly have, with **bold**, a [link](https://example.com) and `code`.',
  '',
  '| Day | Done |',
  '| --- | :--: |',
  '| Mon | yes |',
  '',
  '- [ ] a task',
  '- [x] another',
  '',
].join('\n')

function note(bytes: number): EditorState {
  let doc = '# Plans\n\n'
  while (doc.length < bytes) doc += SECTION
  return EditorState.create({ doc, extensions: [noteMarkdown, writeFocusTracking, writeMode()] })
}

let view: EditorView | null = null

afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

describe('swapping a note into the one editor', () => {
  it('takes less than a frame for an everyday note', (context) => {
    const notes = [note(20_000), note(24_000)]
    view = new EditorView({ state: notes[0]!, parent: document.body })
    const times: number[] = []
    for (let i = 0; i < 21; i++) {
      const next = notes[(i + 1) % 2]!
      const started = performance.now()
      view.setState(next)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[Math.floor(times.length / 2)]!, SWITCH_MS)
  })
})
