import { describe, expect, it } from 'vitest'
import { frontMatterHead, noteFrontMatter, noteTally } from '../../src/core/noteFacts'
import { frontMatterView, propertyCount } from '../../src/core/preview/frontMatterView'
import { noteFields } from '../support/preview-html'

describe('the facts Note Info counts', () => {
  it('counts tasks, words and characters, and reads no front matter from a note without it', () => {
    const markdown = '# Plan\n\n- [x] one\n- [ ] two words\n'
    expect(noteTally(markdown)).toEqual({ tasks: { done: 1, total: 2 }, words: 4, characters: 15 })
    expect(noteFrontMatter(markdown, undefined, 'Untitled')).toBeNull()
  })

  it('reads the front matter as rows and leaves it out of the words', () => {
    const markdown = '---\ntitle: Plan\nauthor: me\n---\n\nBody text'
    expect(noteTally(markdown).words).toBe(2)
    expect(noteFrontMatter(markdown, undefined, 'U')).toEqual({
      kind: 'properties',
      rows: [
        { key: 'title', value: { kind: 'text', text: 'Plan' } },
        { key: 'author', value: { kind: 'text', text: 'me' } },
      ],
    })
  })

  it('reads no front matter from a fence that never closes, as the preview does', () => {
    expect(noteFrontMatter('---\na: 1\n...\nBody', undefined, 'U')).toBeNull()
    expect(noteFrontMatter('---\na: 1\n\nBody', undefined, 'U')).toBeNull()
    expect(noteFrontMatter('---', undefined, 'U')).toBeNull()
  })

  it('finds the front matter of a long note from its head alone', () => {
    const body = 'word '.repeat(50_000)
    const markdown = `---\ntags: [a]\n---\n\n${body}\n---\nb: 2\n---\n`
    const view = {
      kind: 'properties',
      rows: [{ key: 'tags', value: { kind: 'chips', chips: [{ name: 'a' }] } }],
    }
    expect(noteFrontMatter(markdown, undefined, 'U')).toEqual(view)
    const head = frontMatterHead(markdown)
    expect(head).toBe('---\ntags: [a]\n---')
    expect(noteFrontMatter(head!, undefined, 'U')).toEqual(view)
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
