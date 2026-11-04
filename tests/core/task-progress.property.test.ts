import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { taskProgress } from '../../src/core/tasks'

// The line-by-line rules taskProgress keeps, read the plain way: split into lines, then test each.
const TASK_ITEM = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
const FRONT_MATTER_FENCE = /^---[ \t]*$/

function model(markdown: string) {
  const lines = markdown.split(/\r\n?|\n/)
  let first = 0
  if (FRONT_MATTER_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_FENCE.test(l))
    if (close > 0) first = close + 1
  }
  let done = 0
  let total = 0
  let fence: string | undefined
  for (const line of lines.slice(first)) {
    const marks = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (marks && marks[0] === fence[0] && marks.length >= fence.length) fence = undefined
      continue
    }
    if (marks) {
      fence = marks
      continue
    }
    const task = TASK_ITEM.exec(line)
    if (!task) continue
    total += 1
    if (task[1] !== ' ') done += 1
  }
  return { done, total }
}

const piece = fc.constantFrom(
  '- [ ] ',
  '- [x] ',
  '* [X] ',
  '12. [ ]',
  '1) [x]\t',
  '> ',
  '>',
  '  ',
  '\t',
  '```',
  '````',
  '~~~',
  '---',
  '--- ',
  '[ ]',
  '[x]',
  '-',
  'text',
  '\n',
  '\r\n',
  '\r',
  '\n\n',
  '\u2028',
  '\u2029',
  '>  - [ ]',
  '- [x]\u2028',
)

describe('taskProgress', () => {
  it('counts as the line-by-line rules do', () => {
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 40 }), (pieces) => {
        const markdown = pieces.join('')
        expect(taskProgress(markdown)).toEqual(model(markdown))
      }),
      { numRuns: 3000 },
    )
  })
})
