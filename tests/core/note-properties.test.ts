import { describe, expect, it } from 'vitest'
import { noteProperties } from '../../src/core/frontMatter'

describe('noteProperties', () => {
  it('reads front matter as JSON values, keeping dates as their text', () => {
    expect(
      noteProperties(
        '---\ntitle: Plan\nrating: 4.5\ndone: true\ndue: 2026-12-01\nnone:\n---\nBody',
      ),
    ).toEqual({ title: 'Plan', rating: 4.5, done: true, due: '2026-12-01', none: null })
  })

  it('is empty without front matter, or with front matter that is not a map or not YAML', () => {
    expect(noteProperties('# Plan\n\nrating: 4')).toEqual({})
    expect(noteProperties('---\n- a\n- b\n---\n')).toEqual({})
    expect(noteProperties('---\na: [1, 2\n---\n')).toEqual({})
  })
})
