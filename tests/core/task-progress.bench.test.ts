import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../support/budget'
import { taskProgress } from '../../src/core/tasks'

// The live preview counts the open note's tasks on every keystroke, on the main thread.
describe('taskProgress on a long note', () => {
  const block =
    '# Heading\n\nSome text with `code` and **bold** here.\n\n- item one\n  - [ ] task two\n  - [x] task three\n\n```js\nconst a = 1\n- [ ] not a task\n```\n\n> a quote\n\n'
  let note = ''
  while (note.length < 1_000_000) note += block

  it('counts the tasks of 1 MB of Markdown within a frame', (context) => {
    const blocks = Math.ceil(1_000_000 / block.length)
    expect(taskProgress(note)).toEqual({ done: blocks, total: 2 * blocks })
    const times: number[] = []
    for (let i = 0; i < 9; i++) {
      const started = performance.now()
      taskProgress(note)
      times.push(performance.now() - started)
    }
    times.sort((a, b) => a - b)
    expectWithinBudget(context, times[4]!, 6)
  })
})
