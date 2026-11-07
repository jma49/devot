import { describe, expect, it } from 'vitest'
import { taskProgress } from '../../src/core/extract'
import { createBlockSplitter } from '../../src/core/preview/blocks'
import { createSplitFacts } from '../../src/core/preview/live'
import { randomChange, randomLines, seeded } from '../support/random-notes'

const TASKS = [
  '- [ ] open',
  '- [x] done',
  '  * [X] nested',
  '> - [ ] quoted',
  '```',
  '~~~~',
  '---',
  '--- ',
  'title: x',
  '$$',
]

describe("a note's task progress and line count read from its pieces", () => {
  it('match reading the whole note, over random edits', () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const next = seeded(seed)
      const facts = createSplitFacts(createBlockSplitter(40))
      const line = () => TASKS[Math.floor(next() * TASKS.length)]!
      let doc = Array.from({ length: 60 }, () =>
        next() < 0.5 ? line() : randomLines(next, 1),
      ).join('\n')
      for (let edit = 0; edit < 25; edit += 1) {
        const { from, to, insert } = randomChange(next, doc)
        doc = doc.slice(0, from) + (next() < 0.3 ? `\n${line()}\n` : insert) + doc.slice(to)
        expect(facts(doc), `seed ${seed}, edit ${edit}`).toEqual({
          tasks: taskProgress(doc),
          lines: doc.split('\n').length,
        })
      }
    }
  })
})
