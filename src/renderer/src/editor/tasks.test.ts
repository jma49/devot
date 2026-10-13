import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { taskToggle } from './tasks'

const apply = (doc: string, at: number, readOnly = false) => {
  const state = EditorState.create({ doc, extensions: EditorState.readOnly.of(readOnly) })
  const spec = taskToggle(state, at)
  return spec ? state.update(spec).state.doc.toString() : null
}

describe('taskToggle', () => {
  it('ticks and unticks the task whose mark is at the offset', () => {
    expect(apply('- [ ] a\n- [x] b', 3)).toBe('- [x] a\n- [x] b')
    expect(apply('- [ ] a\n- [x] b', 11)).toBe('- [ ] a\n- [ ] b')
    expect(apply('1. [X] c', 4)).toBe('1. [ ] c')
  })

  it('changes nothing when the text there is no longer a box, or the note is read-only', () => {
    expect(apply('- [ ] a', 2)).toBeNull()
    expect(apply('- a', 3)).toBeNull()
    expect(apply('- [ ]', 99)).toBeNull()
    expect(apply('- [ ] a', 3, true)).toBeNull()
  })
})
