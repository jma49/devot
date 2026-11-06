import { describe, expect, it } from 'vitest'
import { noteFacts } from '../../src/core/noteFacts'
import { frontMatterView, propertyCount } from '../../src/core/preview/frontMatterView'
import { noteFields } from '../support/preview-html'

describe('the facts Note Info counts', () => {
  it('counts tasks and words, and reads no front matter from a note without it', () => {
    const facts = noteFacts('# Plan\n\n- [x] one\n- [ ] two words\n', undefined, 'Untitled')
    expect(facts.tasks).toEqual({ done: 1, total: 2 })
    expect(facts.words).toBe(4)
    expect(facts.frontMatter).toBeNull()
  })

  it('reads the front matter as rows and leaves it out of the words', () => {
    const facts = noteFacts('---\ntitle: Plan\nauthor: me\n---\n\nBody text', undefined, 'U')
    expect(facts.words).toBe(2)
    expect(facts.frontMatter).toEqual({
      kind: 'properties',
      rows: [
        { key: 'title', value: { kind: 'text', text: 'Plan' } },
        { key: 'author', value: { kind: 'text', text: 'me' } },
      ],
    })
  })

  it('reads no front matter from a fence that never closes, as the preview does', () => {
    expect(noteFacts('---\na: 1\n...\nBody', undefined, 'U').frontMatter).toBeNull()
    expect(noteFacts('---\na: 1\n\nBody', undefined, 'U').frontMatter).toBeNull()
    expect(noteFacts('---', undefined, 'U').frontMatter).toBeNull()
  })

  it('finds the front matter of a long note from its head alone', () => {
    const body = 'word '.repeat(50_000)
    const facts = noteFacts(`---\ntags: [a]\n---\n\n${body}\n---\nb: 2\n---\n`, undefined, 'U')
    expect(facts.frontMatter).toEqual({
      kind: 'properties',
      rows: [{ key: 'tags', value: { kind: 'chips', chips: [{ name: 'a' }] } }],
    })
  })
})

describe('front matter as rows', () => {
  it('gives the note’s value and what Apply sets for each field that differs', () => {
    const view = frontMatterView(
      'title: Launch plan\nstatus: on hold\ntags: [Work, new]\n',
      noteFields({
        title: 'Draft',
        status: 'active',
        tags: ['home'],
        tagColors: [{ name: 'work', color: 'green' }],
      }),
      'Untitled',
    )
    expect(view).toEqual({
      kind: 'properties',
      rows: [
        {
          key: 'title',
          value: { kind: 'text', text: 'Launch plan' },
          difference: { field: 'title', badge: 'Note: Draft', value: 'Launch plan' },
        },
        {
          key: 'status',
          value: { kind: 'text', text: 'on hold' },
          difference: { field: 'status', badge: 'Note: Active', value: 'on_hold' },
        },
        {
          key: 'tags',
          value: { kind: 'chips', chips: [{ name: 'Work', color: 'green' }, { name: 'new' }] },
          difference: { field: 'tags', badge: 'Note: home', value: '["Work","new"]' },
        },
      ],
    })
  })

  it('keeps YAML that is not a map of keys as written', () => {
    expect(frontMatterView('- a\n- b', undefined, 'U')).toEqual({ kind: 'yaml', yaml: '- a\n- b' })
    expect(frontMatterView('title: [unclosed', undefined, 'U').kind).toBe('yaml')
  })

  it('counts each row, and a block as written as one', () => {
    expect(propertyCount(null)).toBe(0)
    expect(propertyCount(frontMatterView('a: 1\nb: 2', undefined, 'U'))).toBe(2)
    expect(propertyCount(frontMatterView('- a', undefined, 'U'))).toBe(1)
  })
})
