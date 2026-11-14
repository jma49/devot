import { describe, expect, it } from 'vitest'
import { EXPORT_HEADER } from './frontMatter'
import { bodyTags, noteTags } from './importTags'

describe('noteTags', () => {
  it('reads tags and aliases from the front matter and takes them out of it', () => {
    const note =
      '---\ntags: [work, "deep focus"]\naliases:\n  - Plan\n  - Q3 plan\nauthor: me\n---\n# Body\n'
    expect(noteTags(note)).toEqual({
      tags: ['work', 'deep focus'],
      aliases: ['Plan', 'Q3 plan'],
      body: '---\nauthor: me\n---\n# Body\n',
    })
  })

  it('reads the singular keys and a single value, and drops front matter it empties', () => {
    expect(noteTags('---\ntag: solo\nalias: Other name\n---\nText')).toEqual({
      tags: ['solo'],
      aliases: ['Other name'],
      body: 'Text',
    })
  })

  it('reads nested tags with their slashes, without a leading #', () => {
    expect(noteTags('---\ntags: ["#area/home", project]\n---\n').tags).toEqual([
      'area/home',
      'project',
    ])
  })

  it("leaves Devot's own block and a note without front matter as they are", () => {
    const own = `---\n${EXPORT_HEADER}\ntags: [a]\n---\nText`
    expect(noteTags(own)).toEqual({ tags: [], aliases: [], body: own })
    expect(noteTags('# Title\ntags: [a]')).toEqual({
      tags: [],
      aliases: [],
      body: '# Title\ntags: [a]',
    })
  })
})

describe('bodyTags', () => {
  it('reads #tags in the text, nested ones included, each once', () => {
    expect(bodyTags('Plan for #work and #area/home, then #Work again.')).toEqual([
      'work',
      'area/home',
    ])
  })

  it('skips headings, code, links, numbers and words with # inside', () => {
    const text = [
      '# Heading #notatag',
      '`#code` and',
      '```',
      '#fenced',
      '```',
      '[#linked](https://example.com#anchor) issue #42 C# a#b',
      '#real',
    ].join('\n')
    expect(bodyTags(text)).toEqual(['real'])
  })
})
