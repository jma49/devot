import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  frontMatter,
  imageLinks,
  EXPORT_HEADER,
  importTitle,
  markdownFacts,
  unlocatedImages,
} from '../../src/core/import'

// markdownFacts skips the parse for Markdown that cannot hold images (in
// Markdown or as `<img>` tags in raw HTML), front matter or a level-one
// heading; whatever it skips, it must answer exactly as the functions that
// always parse.

const LINES = [
  '# Title',
  '#Title',
  '## Second',
  '   # Indented three',
  '    # Indented four',
  '\t# Tabbed',
  '#',
  'Setext',
  '===',
  '  =  ',
  '=x',
  '---',
  'title: From front matter',
  '# Devot metadata',
  "title: 'Own title'",
  'title: ""',
  'tags: [a, b]',
  '> # In a quote',
  '- # In a list',
  '```',
  '![image](devot://file/0192a6f0-0000-7000-8000-00000000f001)',
  '![ref][r]',
  '[r]: devot://file/0192a6f0-0000-7000-8000-00000000f002',
  '<img src="devot://file/0192a6f0-0000-7000-8000-00000000f003">',
  'Text <IMG alt="x" SRC=devot://file/0192a6f0-0000-7000-8000-00000000f004> inline',
  '<p><img src="a.png"></p>',
  // What Markdown reads in place of a NUL is not what is written: unlocated.
  `<img src="b.png" alt="${String.fromCodePoint(0)}">`,
  '<!-- <img src="c.png"> -->',
  'Plain text with a # hash and = sign.',
  '',
]

const markdown = fc
  .tuple(
    fc.boolean(),
    fc.array(fc.oneof(fc.constantFrom(...LINES), fc.string({ maxLength: 12 })), {
      maxLength: 12,
    }),
  )
  // Some start as Devot's own block does, so its title is read too.
  .map(([own, lines]) => (own ? `---\n${EXPORT_HEADER}\n` : '') + lines.join('\n'))

describe('markdownFacts', () => {
  it('answers like the parsing functions, parsed or not', () => {
    fc.assert(
      fc.property(markdown, fc.constantFrom('Plan.md', 'Folder/Notes 2.md'), (md, path) => {
        const facts = markdownFacts(md)
        expect(facts.links).toEqual(imageLinks(md))
        expect(facts.unlocated).toEqual(unlocatedImages(md))
        expect(facts.frontMatter).toBe(frontMatter(md))
        expect(facts.title(path)).toBe(importTitle(md, path))
      }),
      { numRuns: 400 },
    )
  }, 60_000)

  it('reads a heading, front matter or an image only from Markdown that can hold one', () => {
    expect(markdownFacts('Just text.\n').title('Plan.md')).toBe('Plan')
    expect(markdownFacts('Text\n\n# Heading\n').title('Plan.md')).toBe('Heading')
    expect(markdownFacts('Setext\n===\n').title('Plan.md')).toBe('Setext')
    expect(markdownFacts('---\ntitle: Own\n---\nText\n').title('Plan.md')).toBe('Plan')
    expect(markdownFacts(`---\n${EXPORT_HEADER}\ntitle: Own\n---\nText\n`).title('Plan.md')).toBe(
      'Own',
    )
    expect(markdownFacts('    # code\n').title('Plan.md')).toBe('Plan')
    // An image in raw HTML alone is found too.
    const html = '<p><IMG SRC="devot://file/0192a6f0-0000-7000-8000-00000000f003"></p>\n'
    expect(markdownFacts(html).links.map((link) => link.url)).toEqual([
      'devot://file/0192a6f0-0000-7000-8000-00000000f003',
    ])
  })
})
