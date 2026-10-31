import { describe, expect, it } from 'vitest'
import { frontMatterChange, tagChanges } from './frontMatterApply'

describe('frontMatterChange', () => {
  it('reads the field and value an Apply button carries', () => {
    expect(frontMatterChange('title', 'Launch plan')).toEqual({
      field: 'title',
      value: 'Launch plan',
    })
    expect(frontMatterChange('status', 'on_hold')).toEqual({ field: 'status', value: 'on_hold' })
    expect(frontMatterChange('tags', '["work","q4"]')).toEqual({
      field: 'tags',
      value: ['work', 'q4'],
    })
  })

  it('refuses what the renderer would not have written', () => {
    expect(frontMatterChange('status', 'someday')).toBeNull()
    expect(frontMatterChange('tags', '[1]')).toBeNull()
    expect(frontMatterChange('tags', '{')).toBeNull()
    expect(frontMatterChange('book', 'x')).toBeNull()
    expect(frontMatterChange('title', null)).toBeNull()
  })
})

describe('tagChanges', () => {
  it('adds the names the note lacks and takes off the tags not named, in any case', () => {
    const own = [
      { id: 't1', name: 'Work' },
      { id: 't2', name: 'home' },
    ]
    expect(tagChanges(own, ['work', 'q4'])).toEqual({ add: ['q4'], remove: ['t2'] })
    expect(tagChanges(own, ['HOME', 'work'])).toEqual({ add: [], remove: [] })
    expect(tagChanges([], [])).toEqual({ add: [], remove: [] })
  })
})
