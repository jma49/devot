import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { taskProgress } from '../../src/core/tasks'

// The line-by-line rules taskProgress keeps, read the plain way: split into lines, then test each.
// Fences follow CommonMark: no backtick in a backtick fence's info string, nothing but spaces after
// a closing fence, and a fence in a quote ends with the quote.
const TASK_ITEM = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/
const QUOTE_MARKER = /^ {0,3}>[ \t]?/
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/s
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const FRONT_MATTER_FENCE = /^---[ \t]*$/

function quoted(line: string): { depth: number; rest: string }[] {
  const levels = [{ depth: 0, rest: line }]
  for (let marker = QUOTE_MARKER.exec(line); marker; marker = QUOTE_MARKER.exec(line)) {
    line = line.slice(marker[0].length)
    levels.push({ depth: levels.length, rest: line })
  }
  return levels
}

function model(markdown: string) {
  const lines = markdown.split(/\r\n?|\n/)
  let first = 0
  if (FRONT_MATTER_FENCE.test(lines[0] ?? '')) {
    const close = lines.findIndex((l, i) => i > 0 && FRONT_MATTER_FENCE.test(l))
    if (close > 0) first = close + 1
  }
  let done = 0
  let total = 0
  let fence: { marks: string; depth: number } | undefined
  for (const line of lines.slice(first)) {
    const levels = quoted(line)
    if (fence !== undefined) {
      const inner = levels[fence.depth]
      if (inner) {
        const marks = CLOSING_FENCE.exec(inner.rest)?.[1]
        if (marks && marks[0] === fence.marks[0] && marks.length >= fence.marks.length) {
          fence = undefined
        }
        continue
      }
      fence = undefined
    }
    const innermost = levels.at(-1)!
    const open = OPENING_FENCE.exec(innermost.rest)
    if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
      fence = { marks: open[1]!, depth: innermost.depth }
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
  '```js',
  '`',
  ' ',
  '    ',
  '> ```',
  '>>',
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
