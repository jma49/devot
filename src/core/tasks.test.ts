import { describe, expect, it } from 'vitest'
import { taskProgress } from './tasks'

describe('taskProgress', () => {
  it('counts ticked and open tasks', () => {
    expect(taskProgress('- [x] one\n- [ ] two\n* [X] three\n1. [ ] four')).toEqual({
      done: 2,
      total: 4,
    })
  })

  it('counts nested tasks and tasks in quotes', () => {
    expect(taskProgress('- [ ] a\n  - [x] b\n> - [x] c')).toEqual({
      done: 2,
      total: 3,
    })
  })

  it('is zero for a note without tasks', () => {
    expect(taskProgress('')).toEqual({ done: 0, total: 0 })
    expect(taskProgress('- plain item\n- [link](x)\n[ ] not a list')).toEqual({
      done: 0,
      total: 0,
    })
  })

  it('needs a space or the line end after the box', () => {
    expect(taskProgress('- [x]done\n- [ ]')).toEqual({ done: 0, total: 1 })
  })

  it('skips fenced code', () => {
    const md = '```md\n- [ ] in code\n```\n- [x] real\n~~~\n- [ ] also code\n~~~'
    expect(taskProgress(md)).toEqual({ done: 1, total: 1 })
  })
})
