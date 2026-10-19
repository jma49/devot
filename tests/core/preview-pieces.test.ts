import type { Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  createPieceRenderer,
  renderPreview,
  PIECE_LINE_PROPERTY,
  PIECE_OFFSET_PROPERTIES,
  type PreviewOptions,
  type PreviewPiece,
} from '../../src/core'
import { splitBlocks } from '../../src/core/preview/blocks'
import { sampleNote } from '../../scripts/bench/fixtures'
import { labels } from '../support/preview-html'

// The live preview renders a note in pieces (blocks.ts) and re-renders only
// the pieces that change; put together, they must be the whole note's preview.

const options: PreviewOptions = { labels, loadedEmbeds: [] }

function shifted(node: RootContent, line: number, offset: number): RootContent {
  if (node.type !== 'element') return structuredClone(node)
  const properties = { ...node.properties }
  const at = properties[PIECE_LINE_PROPERTY]
  if (typeof at === 'number') properties[PIECE_LINE_PROPERTY] = at + line - 1
  for (const name of PIECE_OFFSET_PROPERTIES) {
    const value = properties[name]
    if (typeof value === 'number') properties[name] = value + offset
  }
  return {
    ...node,
    properties,
    children: node.children.map((c) => shifted(c, line, offset)) as typeof node.children,
  }
}

/** What the page shows, from pieces and the nodes it kept from earlier calls. */
function assemble(pieces: PreviewPiece[], kept: Map<string, RootContent[]>): Root {
  const children: RootContent[] = []
  for (const piece of pieces) {
    const nodes = piece.nodes ?? kept.get(piece.key)
    if (!nodes) throw new Error(`no nodes for ${piece.key}`)
    kept.set(piece.key, structuredClone(nodes))
    children.push(...nodes.map((n) => shifted(n, piece.line, piece.offset)))
  }
  return { type: 'root', children }
}

// Line breaks between top-level blocks are markup (the page ignores them).
const blocksOnly = (tree: Root): Root => ({
  type: 'root',
  children: tree.children.filter((n) => !(n.type === 'text' && n.value.trim() === '')),
})

const small = () => createPieceRenderer({ pieceLength: 1 })

async function bothWays(markdown: string, render = small()) {
  const whole = await renderPreview(markdown, options)
  const pieces = await render(markdown, options)
  return { pieces, got: blocksOnly(assemble(pieces, new Map())), want: blocksOnly(whole) }
}

const CASES: Record<string, string> = {
  'fences with blank lines':
    '```js\nconst a = 1\n\nconst b = 2\n```\n\nAfter.\n\n~~~\nx\n\n~~~~\n\ny\n~~~\n\nEnd.',
  'an unclosed fence': 'Before.\n\n```\nopen\n\nstill code\n\nmore',
  'math blocks': '$$\na = b\n\nc = d\n$$\n\nText $x$.\n\n$$$\n$$\n\nin\n$$$\n\nEnd.',
  'loose and nested lists':
    '- a\n\n- b\n\n  continued\n\n    code\n- c\n\nPara.\n\n1. one\n\n2. two\n\n10) ten\n\nEnd.',
  'list items that end lists': '- a\n- b\n\n* c\n\n+ d\n\nText\n\n- e',
  'html blocks over blank lines':
    '<details>\n<summary>More</summary>\n\n**Bold** inside.\n\n</details>\n\nAfter.\n\n<div>\n\nIn a div.\n\n</div>\n\nOut.',
  'comments over blank lines':
    'A.\n\n<!-- a comment\n\nstill a comment\n\n-->\n\nB.\n\n<!-- one line -->\n\nC.',
  'inline html left open': 'Some <b>bold\n\nnext paragraph\n\nAnd `<i>` in code.\n\nEnd </b> here.',
  'front matter with blank lines':
    '---\ntitle: A\n\ntags: [a, b]\n---\n\n# Title\n\n---\n\nnot: yaml\n\n---\n\nEnd.',
  'thematic breaks': 'A\n\n---\n\nB\n\n***\n\nC\n\n* * *\n\n- - -\n\nD\n===\n\nE\n---',
  'repeated headings':
    '# Same\n\n## Same\n\n# Same\n\n# Same-1\n\n> # Same\n\n- # Same\n\n# :tada: Party',
  'tasks and images':
    '- [ ] one\n- [x] two\n\n![a](devot://attachment/0b0b0b0b-0000-4000-8000-000000000000)\n\nText ![b|200](https://example.com/b.png) more.\n\n1. [ ] three',
  'indented code': 'Para.\n\n    code\n\n    more code\n\nAfter.',
  'quotes and alerts': '> [!NOTE]\n> Alert.\n\n> Quote\n\n>\n> more\n\nText.',
  tables: '| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n\n|x|\n|-|',
  'link definitions':
    'See [a] and [b][].\n\nText.\n\n[a]: https://example.com/a\n\n[b]: https://example.com/b',
  footnotes: 'Note[^1] and more[^n].\n\nText.\n\n[^1]: First.\n\n[^n]: Second.',
  'definitions in containers': '> [a]: https://example.com\n\nSee [a].',
  'crlf line ends': '# A\r\n\r\nText\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\n- [ ] t\r\n',
  'tabs and spaces': 'A\n\n\tindented\n\n  two spaces\n\nB',
  diagrams:
    '```mermaid\ngraph TD\n  A --> B\n```\n\nText.\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```',
  'code with titles': '```ts title="a.ts"\nlet a = 1\n```\n\n```py line=3-4\nx = 1\n\ny = 2\n```',
  'processing instructions': 'A.\n\n<?php\n\necho 1;\n\n?>\n\nB.',
  'empty and blank notes': '\n\n\n',
}

describe('createPieceRenderer', () => {
  for (const [name, markdown] of Object.entries(CASES)) {
    it(`renders ${name} as the whole note does`, async () => {
      const { got, want } = await bothWays(markdown)
      expect(got).toEqual(want)
    })
  }

  it('renders the benchmark sample as the whole note does, in many pieces', async () => {
    const markdown = sampleNote(20_000)
    for (const [render, least] of [
      [small(), 100],
      [createPieceRenderer(), 5],
    ] as const) {
      const { pieces, got, want } = await bothWays(markdown, render)
      expect(got).toEqual(want)
      expect(pieces.length).toBeGreaterThan(least)
    }
  })

  it('renders notes built from shuffled cases as the whole note does', async () => {
    const parts = Object.entries(CASES)
      .filter(([name]) => !/definitions|footnotes/.test(name))
      .map(([, md]) => md)
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let round = 0; round < 25; round += 1) {
      const picked = Array.from({ length: 6 }, () => parts[Math.floor(random() * parts.length)]!)
      const gaps = picked.map(() => '\n'.repeat(1 + Math.floor(random() * 3)))
      const { got, want } = await bothWays(picked.map((p, i) => p + gaps[i]).join(''))
      expect(got).toEqual(want)
    }
  })

  it('keeps one piece for a note with definitions', () => {
    expect(splitBlocks(CASES['link definitions']!)).toHaveLength(1)
    expect(splitBlocks(CASES['footnotes']!)).toHaveLength(1)
  })

  it('sends only the pieces the caller does not have', async () => {
    const render = small()
    const before = 'One.\n\nTwo.\n\nThree.'
    const kept = new Map<string, RootContent[]>()
    const first = await render(before, options)
    assemble(first, kept)
    expect(first.every((p) => p.nodes)).toBe(true)

    const after = 'One.\n\nTwo, changed.\n\nThree.'
    const second = await render(after, options, [...kept.keys()])
    expect(second.map((p) => p.nodes !== undefined)).toEqual([false, true, false])
    expect(second[2]!.key).toBe(first[2]!.key)
    expect(second[2]!.offset).toBe(first[2]!.offset + 9)
    const whole = await renderPreview(after, options)
    expect(blocksOnly(assemble(second, kept))).toEqual(blocksOnly(whole))
  })

  it('keys a piece by its heading ids, which depend on the headings before it', async () => {
    const render = small()
    const kept = new Map<string, RootContent[]>()
    const first = await render('# A\n\n# B', options)
    assemble(first, kept)
    const markdown = '# B\n\n# B'
    const second = await render(markdown, options, [...kept.keys()])
    expect(second[1]!.key).not.toBe(first[1]!.key)
    expect(second[1]!.nodes).toBeDefined()
    expect(blocksOnly(assemble(second, kept))).toEqual(
      blocksOnly(await renderPreview(markdown, options)),
    )
  })

  it('renders a piece again when the options change', async () => {
    const render = small()
    const first = await render('Text.', options)
    const second = await render('Text.', { ...options, loadedEmbeds: ['https://x'] }, [
      first[0]!.key,
    ])
    expect(second[0]!.key).not.toBe(first[0]!.key)
  })

  it('lets go of the old versions of a piece being edited', async () => {
    const render = createPieceRenderer({ capacity: 40, pieceLength: 1 })
    const first = await render('Keep.\n\nEdit 0.', options)
    for (let i = 1; i <= 10; i++) await render(`Keep.\n\nEdit ${i}.`, options)
    const kept = await render('Keep.\n\nEdit 0.', options)
    expect(kept[0]!.key).toBe(first[0]!.key)
    expect(kept[1]!.key).not.toBe(first[1]!.key)
  })

  it('forgets the oldest pieces past its capacity', async () => {
    const render = createPieceRenderer({ capacity: 2, pieceLength: 1 })
    const first = await render('A.\n\nB.\n\nC.', options)
    const again = await render('A.\n\nB.\n\nC.', options)
    expect(again[0]!.key).not.toBe(first[0]!.key)
    expect(again[2]!.key).not.toBe(first[2]!.key)
  })
})
