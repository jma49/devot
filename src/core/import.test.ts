import { describe, expect, it } from 'vitest'
import {
  EXPORT_HEADER,
  frontMatter,
  imageLinks,
  importTitle,
  readFrontMatter,
  resolveImagePath,
  unlocatedImages,
} from './import'
import { replaceRanges, textDiff } from './text'

describe('front matter', () => {
  it('is the YAML block at the very start, without its fences', () => {
    expect(frontMatter('---\ntitle: A\n---\n# Body')).toBe('title: A')
    expect(frontMatter('---\r\ntitle: A\r\ntags: [x]\r\n---\r\nBody')).toBe('title: A\r\ntags: [x]')
    expect(frontMatter('---\n---\nBody')).toBe('')
    expect(frontMatter('---\ntitle: A\n---')).toBe('title: A')
  })

  it('needs both fences at the start of the note', () => {
    expect(frontMatter('Intro\n---\ntitle: A\n---\n')).toBeNull()
    expect(frontMatter('---\ntitle: A\nno closing fence')).toBeNull()
    expect(frontMatter(' ---\ntitle: A\n---\n')).toBeNull()
    expect(frontMatter('')).toBeNull()
  })

  it('reads title, notebook, tags and status; ignores every other key', () => {
    const meta = readFrontMatter(
      '---\ntitle: "Weekly: plan"\nNotebook: \' Work / Plans \'\ntags: [work, "deep focus", \'#later\']\nstatus: Active\nauthor: me\n---\n',
    )
    expect(meta).toEqual({
      title: 'Weekly: plan',
      notebook: 'Work / Plans',
      tags: ['work', 'deep focus', 'later'],
      status: 'active',
    })
  })

  it('reads tags as a block list, a comma list or a single value', () => {
    expect(readFrontMatter('---\ntags:\n  - one\n  - "two words"\nother: x\n---\n').tags).toEqual([
      'one',
      'two words',
    ])
    expect(readFrontMatter('---\ntags:\n- three\n---\n').tags).toEqual(['three'])
    expect(readFrontMatter('---\ntags: one, two ,#three\n---\n').tags).toEqual([
      'one',
      'two',
      'three',
    ])
    expect(readFrontMatter('---\nTags: solo\n---\n').tags).toEqual(['solo'])
    expect(readFrontMatter('---\ntags:\n---\n').tags).toEqual([])
  })

  it('drops empty and duplicate tags (case-insensitive), keeping the first spelling', () => {
    expect(readFrontMatter('---\ntags: [Work, work, "", "#", WORK, home]\n---\n').tags).toEqual([
      'Work',
      'home',
    ])
  })

  it('maps the five statuses, in any case, with spaces, hyphens or underscores', () => {
    const status = (value: string) => readFrontMatter(`---\nstatus: ${value}\n---\n`).status
    expect(status('active')).toBe('active')
    expect(status('On Hold')).toBe('on_hold')
    expect(status('on-hold')).toBe('on_hold')
    expect(status('ON_HOLD')).toBe('on_hold')
    expect(status('"completed"')).toBe('completed')
    expect(status('Dropped')).toBe('dropped')
    expect(status('none')).toBe('none')
    expect(status('done')).toBeNull()
    expect(status('')).toBeNull()
  })

  it('gives nothing for a note without front matter', () => {
    expect(readFrontMatter('# Title\n\ntags: [a]\n')).toEqual({
      title: null,
      notebook: null,
      tags: [],
      status: null,
    })
  })
})

describe('import title', () => {
  it("prefers the title in Devot's own front matter, and ignores any other", () => {
    expect(
      importTitle(`---\n${EXPORT_HEADER}\ntitle: From YAML\n---\n# From heading\n`, 'a/file.md'),
    ).toBe('From YAML')
    expect(importTitle('---\ntitle: From YAML\n---\n# From heading\n', 'a/file.md')).toBe(
      'From heading',
    )
  })

  it('then takes the first level-one heading, as plain text', () => {
    expect(importTitle('Intro\n\n## Sub\n\n# The *real* `title`\n\n# Second', 'x.md')).toBe(
      'The real title',
    )
    expect(importTitle('Setext title\n===\n\nBody', 'x.md')).toBe('Setext title')
    expect(importTitle('---\nauthor: me\n---\n# After front matter\n', 'x.md')).toBe(
      'After front matter',
    )
  })

  it('ignores headings inside code blocks', () => {
    expect(importTitle('```\n# not a heading\n```\n', 'notes/Plain name.md')).toBe('Plain name')
  })

  it('falls back to the file name without its extension', () => {
    expect(importTitle('Just text', 'Projects/Q4 plan.markdown')).toBe('Q4 plan')
    expect(importTitle('# \n', 'Empty heading.md')).toBe('Empty heading')
    expect(importTitle('---\ntitle: ""\n---\n', 'Blank.md')).toBe('Blank')
  })

  it('keeps the title on one line', () => {
    expect(importTitle('# Line one  \n', 'x.md')).toBe('Line one')
  })
})

describe('image links', () => {
  const urls = (markdown: string) =>
    imageLinks(markdown).map((link) => [markdown.slice(link.start, link.end), link.url])

  it('finds inline images and points at their raw destination', () => {
    expect(urls('A ![cat](img/cat.png) and ![dog](./dog.jpg "Title").')).toEqual([
      ['img/cat.png', 'img/cat.png'],
      ['./dog.jpg', './dog.jpg'],
    ])
  })

  it('handles angle brackets, escapes, parentheses and nested brackets', () => {
    expect(urls('![a](<my pics/a b.png>)')).toEqual([['<my pics/a b.png>', 'my pics/a b.png']])
    expect(urls('![a](pics/x\\(1\\).png)')).toEqual([['pics/x\\(1\\).png', 'pics/x(1).png']])
    expect(urls('![a](pics/x(1).png)')).toEqual([['pics/x(1).png', 'pics/x(1).png']])
    expect(urls('![see [this](a.md)](shot.png)')).toEqual([['shot.png', 'shot.png']])
    expect(urls('![a](b.png "has ](odd) title")')).toEqual([['b.png', 'b.png']])
  })

  it('finds reference definitions that images use, not ones only links use', () => {
    const md = '![Logo][logo] and [doc][ref]\n\n[logo]: assets/logo.png "Logo"\n[ref]: other.png\n'
    expect(urls(md)).toEqual([['assets/logo.png', 'assets/logo.png']])
    expect(urls('![logo]\n\n[logo]: <a b.png>\n')).toEqual([['<a b.png>', 'a b.png']])
  })

  it('skips code, math and links that are not images', () => {
    const md = [
      '```md',
      '![in fence](a.png)',
      '```',
      '',
      '`![inline code](b.png)`',
      '',
      '$$',
      '![math](c.png)',
      '$$',
      '',
      '[a link](d.png) `<img src="e.png">`',
    ].join('\n')
    expect(urls(md)).toEqual([])
  })

  it('finds the src of each <img> in raw HTML, read as HTML reads it', () => {
    expect(
      urls(`<img src="e.png"> and <IMG alt="x" SRC='f.png'> and <img width=9 src=g.png>`),
    ).toEqual([
      ['e.png', 'e.png'],
      ['f.png', 'f.png'],
      ['g.png', 'g.png'],
    ])
    expect(urls('<p align="center">\n  <img width="300" src="a b.png" />\n</p>\n')).toEqual([
      ['a b.png', 'a b.png'],
    ])
    // Character references in the value, as in any HTML.
    expect(urls('<img src="Q&amp;A.png">')).toEqual([['Q&amp;A.png', 'Q&A.png']])
    // Inside a quote or a list item, also across lines and after a tab.
    expect(urls('> <img\n> src="q.png">\n')).toEqual([['q.png', 'q.png']])
    expect(urls('>\t<div>\n>\t<img src="t.png">\n>\t</div>\n')).toEqual([['t.png', 't.png']])
    expect(urls('- item\n\n  <div>\n  <img src="l.png">\n  </div>\n')).toEqual([['l.png', 'l.png']])
    // Only the first src counts, and only an img's.
    expect(urls('<img src="1.png" src="2.png"> <video src="v.mp4"> <a href="x.png">')).toEqual([
      ['1.png', '1.png'],
    ])
  })

  it('leaves HTML comments and the text of script and style alone', () => {
    const md = [
      '<!-- <img src="x.png"> -->',
      '',
      '<div><!-- <img src="y.png"> --><style>a {} <img src="z.png"></style></div>',
      '',
      // Only the element's own end tag ends its text.
      '<div><style>a {}</styles><img src="w.png"></style></div>',
      '',
    ].join('\n')
    expect(urls(md)).toEqual([])
    // In any case, and before a line break too.
    expect(urls('<div><script>1</SCRIPT\n><img src="v.png"></div>\n')).toEqual([['v.png', 'v.png']])
  })

  it('finds the src after text that grows when lowercased', () => {
    // A dotted capital I lowercases to two code units.
    const dotted = String.fromCodePoint(0x130)
    expect(urls(`<p>${dotted}stanbul</p>\n<img src="a.png">\n`)).toEqual([['a.png', 'a.png']])
    expect(urls(`<div><script>"${dotted}"</SCRIPT><img src="b.png"></div>\n`)).toEqual([
      ['b.png', 'b.png'],
    ])
    // Many of them in a style, right before its end tag.
    expect(urls(`<div><style>${dotted.repeat(12)}</STYLE><img src="c.png"></div>\n`)).toEqual([
      ['c.png', 'c.png'],
    ])
  })

  it('reads destinations with spaces of other kinds, deep parentheses or character references', () => {
    const narrow = String.fromCodePoint(0x202f)
    const shot = `Screenshot%202026-10-10%20at%2012.34.56${narrow}PM.png`
    expect(urls(`![shot](${shot})`)).toEqual([[shot, shot]])
    expect(urls(`![shot][s]\n\n[s]: ${shot}\n`)).toEqual([[shot, shot]])
    expect(urls('![a](x((1)).png "t")')).toEqual([['x((1)).png', 'x((1)).png']])
    expect(urls('![a](Q&amp;A.png) ![b](<R&#38;D.png>)')).toEqual([
      ['Q&amp;A.png', 'Q&A.png'],
      ['<R&#38;D.png>', 'R&D.png'],
    ])
  })

  it('tells which images it could not find the destination of', () => {
    // What Markdown reads in place of a NUL is not what is written.
    const nul = String.fromCodePoint(0)
    const md = `<img src="a${nul}.png"> ![b](b.png)`
    expect(urls(md)).toEqual([['b.png', 'b.png']])
    expect(unlocatedImages(md)).toEqual([`a${String.fromCodePoint(0xfffd)}.png`])
    expect(unlocatedImages('![b](b.png) <img src="c.png">')).toEqual([])
  })

  it('reports every destination, local or not; resolving decides', () => {
    expect(urls('![r](https://example.com/x.png) ![d](data:image/png;base64,AAAA)')).toEqual([
      ['https://example.com/x.png', 'https://example.com/x.png'],
      ['data:image/png;base64,AAAA', 'data:image/png;base64,AAAA'],
    ])
  })

  it('works after front matter and with CRLF line ends', () => {
    expect(urls('---\ntitle: x\n---\r\n![a](a.png)\r\n')).toEqual([['a.png', 'a.png']])
  })
})

describe('resolving image paths', () => {
  it('resolves against the note folder', () => {
    expect(resolveImagePath('Projects/plan.md', 'img/a.png')).toBe('Projects/img/a.png')
    expect(resolveImagePath('Projects/plan.md', './a.png')).toBe('Projects/a.png')
    expect(resolveImagePath('Projects/Deep/plan.md', '../../assets/a.png')).toBe('assets/a.png')
    expect(resolveImagePath('plan.md', 'a.png')).toBe('a.png')
  })

  it('treats a leading slash as the import folder', () => {
    expect(resolveImagePath('Projects/plan.md', '/assets/a.png')).toBe('assets/a.png')
  })

  it('decodes percent escapes and drops a query or fragment', () => {
    expect(resolveImagePath('n.md', 'my%20pics/a%20b.png')).toBe('my pics/a b.png')
    expect(resolveImagePath('n.md', 'a.png?v=2#top')).toBe('a.png')
    expect(resolveImagePath('n.md', 'bad%zz.png')).toBe('bad%zz.png')
  })

  it('refuses paths outside the folder, remote URLs and empty ones', () => {
    expect(resolveImagePath('Projects/plan.md', '../../a.png')).toBeNull()
    expect(resolveImagePath('plan.md', '..')).toBeNull()
    expect(resolveImagePath('plan.md', 'https://example.com/a.png')).toBeNull()
    expect(resolveImagePath('plan.md', 'file:///Users/me/a.png')).toBeNull()
    expect(resolveImagePath('plan.md', 'devot://file/x')).toBeNull()
    expect(resolveImagePath('plan.md', '//cdn.example.com/a.png')).toBeNull()
    expect(resolveImagePath('plan.md', '#anchor')).toBeNull()
    expect(resolveImagePath('plan.md', '')).toBeNull()
    expect(resolveImagePath('plan.md', 'C:\\pics\\a.png')).toBeNull()
  })
})

describe('text edits', () => {
  it('replaces ranges, keeping everything else byte for byte', () => {
    expect(
      replaceRanges('one two three', [
        { start: 8, end: 13, text: '3' },
        { start: 0, end: 3, text: '1' },
      ]),
    ).toBe('1 two 3')
  })

  it('diffs to the smallest change between the common prefix and suffix', () => {
    expect(textDiff('', 'abc')).toEqual({ index: 0, remove: 0, insert: 'abc' })
    expect(textDiff('hello world', 'hello brave world')).toEqual({
      index: 6,
      remove: 0,
      insert: 'brave ',
    })
    expect(textDiff('abc', 'abc')).toEqual({ index: 3, remove: 0, insert: '' })
    expect(textDiff('abcdef', 'abef')).toEqual({ index: 2, remove: 2, insert: '' })
  })

  it('never splits a surrogate pair', () => {
    const diff = textDiff('a\u{1F600}b', 'a\u{1F601}b')
    expect(diff).toEqual({ index: 1, remove: 2, insert: '\u{1F601}' })
  })
})
