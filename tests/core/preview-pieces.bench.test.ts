import { describe, it } from 'vitest'
import { createPieceRenderer, type PreviewOptions } from '../../src/core'
import { sampleNote } from '../../scripts/bench/fixtures'
import { expectWithinBudget } from '../support/budget'
import { labels } from '../support/preview-html'

// A keystroke in Split view renders the note's pieces again in the core worker. Footnotes and
// reference definitions reach across the whole note, and a note that had them once rendered whole
// on every keystroke (about 340 ms on a 250 KB note); now only the edited piece renders again.
const EDIT_BUDGET_MS = 30
const EDITS = 7

const options: PreviewOptions = { labels, loadedEmbeds: [] }

/** The benchmark sample with a footnote and a reference definition in every section. */
function noteWithDefinitions(bytes: number): string {
  let section = 0
  return sampleNote(bytes)
    .replace(/Paragraph (\d+) goes on/g, 'Paragraph $1[^s$1] goes on, see [section $1],')
    .replace(/\n\n---(?=\n\n)/g, () => {
      section += 1
      return `\n\n[^s${section}]: Footnote ${section} with *emphasis*.\n\n[section ${section}]: https://example.com/s${section}\n\n---`
    })
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!

describe('the live preview of a 250 KB note with footnotes and reference definitions', () => {
  it('renders an edit in the middle within its budget', async (context) => {
    const render = createPieceRenderer()
    const note = noteWithDefinitions(250_000)
    let known = (await render(note, options)).map((piece) => piece.key)
    const at = note.indexOf('goes on for a while', note.length / 2)
    const times: number[] = []
    for (let i = 1; i <= EDITS; i += 1) {
      const edited = `${note.slice(0, at)}${'x'.repeat(i)}${note.slice(at)}`
      const start = performance.now()
      const pieces = await render(edited, options, known)
      times.push(performance.now() - start)
      known = pieces.map((piece) => piece.key)
    }
    expectWithinBudget(context, median(times), EDIT_BUDGET_MS)
  })
})
