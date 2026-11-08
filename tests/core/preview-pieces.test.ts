import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  createPieceRenderer,
  drawCodeMarks,
  renderPreview,
  PIECE_LINE_PROPERTY,
  PIECE_OFFSET_PROPERTIES,
  type PreviewOptions,
  type PreviewPiece,
} from '../../src/core'
import { splitBlocks } from '../../src/core/preview/blocks'
import { KEPT_CHARACTERS } from '../../src/core/preview'
import { sampleNote } from '../../scripts/bench/fixtures'
import { labels, noteFields } from '../support/preview-html'

// The live preview renders a note in pieces (blocks.ts) and re-renders only
// the pieces that change; put together, they must be the whole note's preview.

const options: PreviewOptions = { labels, loadedEmbeds: [] }

const marked = (node: Element) =>
  typeof node.properties[PIECE_LINE_PROPERTY] === 'number' ||
  PIECE_OFFSET_PROPERTIES.some((name) => typeof node.properties[name] === 'number')

/** `node` with its lines and offsets counted from the note, each marked element from `baseOf()`. */
function shifted(node: RootContent, baseOf: () => { line: number; offset: number }): RootContent {
  if (node.type !== 'element') return structuredClone(node)
  const properties = { ...node.properties }
  if (marked(node)) {
    const { line, offset } = baseOf()
    const at = properties[PIECE_LINE_PROPERTY]
    if (typeof at === 'number') properties[PIECE_LINE_PROPERTY] = at + line - 1
    for (const name of PIECE_OFFSET_PROPERTIES) {
      const value = properties[name]
      if (typeof value === 'number') properties[name] = value + offset
    }
  }
  return {
    ...node,
    properties,
    children: node.children.map((c) => shifted(c, baseOf)) as typeof node.children,
  }
}

/** What the page shows, from pieces and the nodes it kept from earlier calls. */
function assemble(pieces: PreviewPiece[], kept: Map<string, RootContent[]>): Root {
  const children: RootContent[] = []
  for (const piece of pieces) {
    const nodes = piece.nodes ?? kept.get(piece.key)
    if (!nodes) throw new Error(`no nodes for ${piece.key}`)
    kept.set(piece.key, structuredClone(nodes))
    const bases = piece.parts?.flatMap((part) => Array<typeof part>(part.marks).fill(part))
    let mark = 0
    const baseOf = () => (bases ? bases[mark++]! : piece)
    children.push(...nodes.map((n) => shifted(n, baseOf)))
    expect(mark).toBe(bases?.length ?? mark)
  }
  return { type: 'root', children }
}

// Line breaks between top-level blocks are markup (the page ignores them). Each piece draws the
// code marks it uses, where the whole note draws each once: compared as the page shows them.
const blocksOnly = (tree: Root): Root => ({
  type: 'root',
  children: drawCodeMarks(tree).children.filter(
    (n) => !(n.type === 'text' && n.value.trim() === ''),
  ),
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
  'definitions in containers':
    '> [a]: https://example.com\n\nSee [a].\n\n- item\n\n  [^q]: In a list.\n\nCall[^q].',
  'footnotes called again and from other pieces':
    'One[^a] and two[^b].\n\nAgain[^a] and [^A].\n\n[^b]: Bee *b*.\n\n[^a]: Ay with [link].\n\n[link]: https://example.com/l "Title"\n\nLast[^b].',
  'footnotes inside footnotes': 'Call[^x].\n\n[^x]: Outer, see[^y].\n\n[^y]: Inner[^x].',
  'a footnote ending in a code block': 'Call[^c].\n\n[^c]: Text.\n\n        code\n\nAfter[^c].',
  'repeated definitions':
    '[a] and [^n].\n\n[a]: https://example.com/first\n\n[^n]: First note.\n\n[a]: https://example.com/second\n\n[^n]: Second note.\n\n[a][] again[^n].',
  'definitions in code':
    '```ts\ntype A = {\n  [key: string]: number\n}\n```\n\nText.\n\n```\n[^x]: not a note\n```\n\nCall [^x] stays text.',
  'unused definitions': 'Text.\n\n[^u]: Never called.\n\n[u]: https://example.com\n\nMore.',
  'labels by case and spacing':
    'See [Foo  Bar] and [^Note One].\n\n[foo bar]: https://example.com/fb\n\n[^note one]: Spaced.',
  'images by reference':
    '![alt][img]\n\nText.\n\n[img]: devot://attachment/0b0b0b0b-0000-4000-8000-000000000000',
  'front matter and footnotes': '---\ntitle: A\n---\n\nCall[^1].\n\n[^1]: Note.',
  'tasks and math in footnotes':
    'Call[^m].\n\nText.\n\n[^m]: Math $x^2$ and a list:\n\n    - [ ] inside\n    - [x] done\n\nAfter.',
  'an unclosed fence after footnotes':
    'Call[^1] and [r].\n\n[^1]: Note.\n\n[r]: https://example.com\n\n```\nopen [r] [^1]\n\nstill code',
  'crlf line ends': '# A\r\n\r\nText\r\n\r\n```\r\na\r\n\r\nb\r\n```\r\n\r\n- [ ] t\r\n',
  'tabs and spaces': 'A\n\n\tindented\n\n  two spaces\n\nB',
  diagrams:
    '```mermaid\ngraph TD\n  A --> B\n```\n\nText.\n\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```',
  'code with titles': '```ts title="a.ts"\nlet a = 1\n```\n\n```py line=3-4\nx = 1\n\ny = 2\n```',
  'headings in footnotes': '# Same\n\nCall[^h].\n\n[^h]: Note\n\n    # Same\n\n# Same\n\nEnd.',
  'processing instructions': 'A.\n\n<?php\n\necho 1;\n\n?>\n\nB.',
  'empty and blank notes': '\n\n\n',
}

const LONG_NOTE = [...Array(500).keys()]
  .map((i) => `Paragraph ${i}: ${'word '.repeat(70)}`)
  .join('\n\n')

/** Characters of source whose pieces came back from the cache. */
function keptOf(first: readonly PreviewPiece[], again: readonly PreviewPiece[]): number {
  const ends = [...again.slice(1).map((piece) => piece.offset), LONG_NOTE.length]
  return again
    .map((piece, i) => (piece.key === first[i]?.key ? ends[i]! - piece.offset : 0))
    .reduce((sum, length) => sum + length, 0)
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
    const parts = Object.values(CASES)
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let round = 0; round < 25; round += 1) {
      const picked = Array.from({ length: 6 }, () => parts[Math.floor(random() * parts.length)]!)
      const gaps = picked.map(() => '\n'.repeat(1 + Math.floor(random() * 3)))
      const { got, want } = await bothWays(picked.map((p, i) => p + gaps[i]).join(''))
      expect(got).toEqual(want)
    }
  })

  it('renders a note edited again and again as a first render of it does', async () => {
    const parts = [...Object.values(CASES), '# Same\n\nRepeated.', '# Same\n\nRepeated.']
    let seed = 11
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const render = small()
    const kept = new Map<string, RootContent[]>()
    let known: string[] = []
    let markdown = parts.join('\n\n')
    for (let round = 0; round < 40; round += 1) {
      const at = Math.floor(random() * markdown.length)
      const removed = random() < 0.3 ? Math.floor(random() * 30) : 0
      const added = parts[Math.floor(random() * parts.length)]!.slice(0, Math.floor(random() * 25))
      markdown = markdown.slice(0, at) + added + markdown.slice(at + removed)
      const pieces = await render(markdown, options, known)
      known = pieces.map((piece) => piece.key)
      const want = blocksOnly(assemble(await small()(markdown, options), new Map()))
      expect(blocksOnly(assemble(pieces, kept)), `round ${round}`).toEqual(want)
    }
  })

  it('keeps pieces with the same text apart as copies of it come and go', async () => {
    const render = small()
    const kept = new Map<string, RootContent[]>()
    let known: string[] = []
    for (const markdown of [
      'A\n\n# X\n\nB\n\n# X\n',
      'A\n\n# X\n\nB\n\n# X\n\n# X\n',
      '# X\n\nA\n\n# X\n\nB\n\n# X\n',
      '# X\n\nA typed\n\n# X\n\nB\n\n# X\n',
      'A typed\n\n# X\n\nB\n\n# X\n',
    ]) {
      const pieces = await render(markdown, options, known)
      known = pieces.map((piece) => piece.key)
      expect(new Set(known).size).toBe(known.length)
      const sent = pieces.flatMap((piece) => piece.nodes ?? []).filter((n) => n.type === 'element')
      expect(new Set(sent).size).toBe(sent.length)
      const want = blocksOnly(assemble(await small()(markdown, options), new Map()))
      expect(blocksOnly(assemble(pieces, kept))).toEqual(want)
    }
  })

  it('cuts a note with definitions into pieces', () => {
    expect(splitBlocks(CASES['link definitions']!, 1)).toHaveLength(4)
    expect(splitBlocks(CASES['footnotes']!, 1)).toHaveLength(4)
  })

  it('sends again only the edited piece of a note with footnotes and reference definitions', async () => {
    const render = small()
    const note = (edit: string) =>
      [...Array(12).keys()]
        .map(
          (i) =>
            `Para ${i}${i === 5 ? edit : ''} calls[^n${i}] and [ref ${i}].\n\n[^n${i}]: Note ${i}, [ref ${i}].\n\n[ref ${i}]: https://example.com/${i}`,
        )
        .join('\n\n')
    const kept = new Map<string, RootContent[]>()
    const first = await render(note(''), options)
    assemble(first, kept)
    expect(first.length).toBeGreaterThan(30)
    const markdown = note(' edited')
    const second = await render(markdown, options, [...kept.keys()])
    expect(second.filter((p) => p.nodes !== undefined).map((p) => p.line)).toEqual([31])
    expect(blocksOnly(assemble(second, kept))).toEqual(
      blocksOnly(await renderPreview(markdown, options)),
    )
  })

  it('sends the list of notes again only when a note in it changed', async () => {
    const render = createPieceRenderer({ pieceLength: 30 })
    const note = (edit: string, noteEdit = '') =>
      [...Array(8).keys()]
        .map(
          (i) =>
            `Para ${i}${i === 5 ? edit : ''} calls[^n${i}].\n\n[^n${i}]: Note ${i}${i === 5 ? noteEdit : ''}.`,
        )
        .join('\n\n')
    const kept = new Map<string, RootContent[]>()
    const first = await render(note(''), options)
    assemble(first, kept)
    const edited = await render(note(' edited'), options, [...kept.keys()])
    expect(edited.filter((p) => p.nodes !== undefined).map((p) => p.line)).toEqual([21])
    assemble(edited, kept)
    const markdown = note(' edited', ' edited')
    const both = await render(markdown, options, [...kept.keys()])
    expect(both.filter((p) => p.nodes !== undefined).map((p) => p.line)).toEqual([21, 3])
    expect(blocksOnly(assemble(both, kept))).toEqual(
      blocksOnly(await renderPreview(markdown, options)),
    )
  })

  it('keeps the list of notes when lines and characters are added above the notes it lists', async () => {
    const render = createPieceRenderer({ pieceLength: 30 })
    const note = (edit: string) =>
      [...Array(8).keys()]
        .map(
          (i) =>
            `Para ${i}${i === 1 ? edit : ''} calls[^n${i}].\n\n[^n${i}]: Note ${i}, ![i](https://example.com/${i}.png)\n\n    - [ ] task ${i}`,
        )
        .join('\n\n')
    const kept = new Map<string, RootContent[]>()
    assemble(await render(note(''), options), kept)
    for (const edit of [' typed', ' typed\nand a line']) {
      const markdown = note(edit)
      const next = await render(markdown, options, [...kept.keys()])
      const sent = next.filter((p) => p.nodes !== undefined)
      expect(sent.map((p) => p.line)).toContain(7)
      expect(sent.filter((p) => p.parts)).toEqual([])
      expect(blocksOnly(assemble(next, kept))).toEqual(
        blocksOnly(await renderPreview(markdown, options)),
      )
    }
  })

  it('names the headings in footnotes after every other heading, again when one is added before them', async () => {
    const render = small()
    const kept = new Map<string, RootContent[]>()
    const before = 'Call[^h].\n\n[^h]: Note\n\n    # Same\n\nEnd.'
    assemble(await render(before, options), kept)
    const markdown = `# Same\n\n${before}`
    const next = await render(markdown, options, [...kept.keys()])
    expect(blocksOnly(assemble(next, kept))).toEqual(
      blocksOnly(await renderPreview(markdown, options)),
    )
  })

  it('numbers the footnotes again when a call is added before them', async () => {
    const render = small()
    const kept = new Map<string, RootContent[]>()
    const before = 'A[^a].\n\nB[^b].\n\n[^a]: Ay.\n\n[^b]: Bee.'
    assemble(await render(before, options), kept)
    const markdown = 'B first[^b]. A[^a].\n\nB[^b].\n\n[^a]: Ay.\n\n[^b]: Bee.'
    const second = await render(markdown, options, [...kept.keys()])
    expect(blocksOnly(assemble(second, kept))).toEqual(
      blocksOnly(await renderPreview(markdown, options)),
    )
  })

  it('renders a piece again when a definition it uses changes in another piece', async () => {
    const render = small()
    const kept = new Map<string, RootContent[]>()
    assemble(await render('See [a].\n\n[a]: https://example.com/1', options), kept)
    const markdown = 'See [a].\n\n[a]: https://example.com/2'
    const second = await render(markdown, options, [...kept.keys()])
    expect(second[0]!.nodes).toBeDefined()
    expect(blocksOnly(assemble(second, kept))).toEqual(
      blocksOnly(await renderPreview(markdown, options)),
    )
  })

  it('still tells a tag that closes itself from one that stays open', () => {
    expect(splitBlocks('<foo a="1" />\n\nx', 1)).toHaveLength(2)
    expect(splitBlocks('<foo a="1">\n\nx', 1)).toHaveLength(1)
    expect(splitBlocks('<foo a="1"\n\nx\n\n<bar />', 1)).toHaveLength(1)
  })

  it('counts every tag of a line that never closes one', () => {
    expect(splitBlocks('<a <a </a\n\nx', 1)).toHaveLength(1)
    expect(splitBlocks('<a <a </a </a\n\nx', 1)).toHaveLength(2)
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

  it("renders only the front matter's piece again when the note's fields change", async () => {
    const render = small()
    const markdown = '---\ntitle: A\n---\n\nOne.\n\nTwo.'
    const first = await render(markdown, { ...options, note: noteFields({ title: 'A' }) })
    const second = await render(
      markdown,
      { ...options, note: noteFields({ title: 'B' }) },
      first.map((p) => p.key),
    )
    expect(second.map((p) => p.nodes !== undefined)).toEqual([true, false, false])
    const plain = await render('One.\n\nTwo.', { ...options, note: noteFields({ title: 'A' }) })
    const retitled = await render(
      'One.\n\nTwo.',
      { ...options, note: noteFields({ title: 'B' }) },
      plain.map((p) => p.key),
    )
    expect(retitled.every((p) => p.nodes === undefined)).toBe(true)
  })

  it('lets go of the old versions of a piece being edited', async () => {
    const render = createPieceRenderer({ capacity: 40, pieceLength: 1 })
    const first = await render('Keep.\n\nEdit 0.', options)
    for (let i = 1; i <= 10; i++) await render(`Keep.\n\nEdit ${i}.`, options)
    const kept = await render('Keep.\n\nEdit 0.', options)
    expect(kept[0]!.key).toBe(first[0]!.key)
    expect(kept[1]!.key).not.toBe(first[1]!.key)
  })

  it('forgets the pieces the note no longer shows, oldest first, past its capacity', async () => {
    const render = createPieceRenderer({ capacity: 2, pieceLength: 1 })
    const first = await render('A.\n\nB.\n\nC.', options)
    await render('D.', options)
    const again = await render('A.\n\nB.\n\nC.', options)
    expect(again[0]!.key).not.toBe(first[0]!.key)
    expect(again[1]!.key).not.toBe(first[1]!.key)
    expect(again[2]!.key).toBe(first[2]!.key)
  })

  it('keeps little of a note it showed before, however long the note', async () => {
    expect(LONG_NOTE.length).toBeGreaterThan(3 * KEPT_CHARACTERS)
    const render = createPieceRenderer()
    const first = await render(LONG_NOTE, options)
    await render('Another note.', options)
    expect(keptOf(first, await render(LONG_NOTE, options))).toBeLessThanOrEqual(KEPT_CHARACTERS)
  })

  it('keeps little of a note whose preview closed, with no other note shown', async () => {
    const render = createPieceRenderer()
    const first = await render(LONG_NOTE, options)
    render.forgetShown()
    expect(keptOf(first, await render(LONG_NOTE, options))).toBeLessThanOrEqual(KEPT_CHARACTERS)
  })

  it('keeps little of a note whose preview closed while it was rendered', async () => {
    const render = createPieceRenderer()
    const rendering = render(LONG_NOTE, options)
    render.forgetShown()
    const first = await rendering
    expect(keptOf(first, await render(LONG_NOTE, options))).toBeLessThanOrEqual(KEPT_CHARACTERS)
  })

  describe('keeps none of the footnotes of a note whose pieces it let go', () => {
    const FOOTNOTED = [...Array(6).keys()]
      .map((i) => `Para ${i} calls[^n${i}].\n\n[^n${i}]: Note ${i}.`)
      .join('\n\n')
    // The list's key holds the version the renderer remembers of each note in it.
    const listKey = (pieces: readonly PreviewPiece[]) => pieces.at(-1)!.key
    const forgetting = () => createPieceRenderer({ pieceLength: 30, capacity: 0 })

    it('when another note is shown', async () => {
      const render = forgetting()
      const first = await render(FOOTNOTED, options)
      expect(listKey(first)).toMatch(/^notes /)
      await render('Another note.', options)
      expect(listKey(await render(FOOTNOTED, options))).not.toBe(listKey(first))
    })

    it('when its preview closed', async () => {
      const render = forgetting()
      const first = await render(FOOTNOTED, options)
      render.forgetShown()
      expect(listKey(await render(FOOTNOTED, options))).not.toBe(listKey(first))
    })

    it('when its preview closed while it was rendered', async () => {
      const render = forgetting()
      const rendering = render(FOOTNOTED, options)
      render.forgetShown()
      const first = await rendering
      expect(listKey(await render(FOOTNOTED, options))).not.toBe(listKey(first))
    })

    it('but the versions of those it keeps, so the list is not sent again', async () => {
      const render = createPieceRenderer({ pieceLength: 30 })
      const first = await render(FOOTNOTED, options)
      render.forgetShown()
      await render('Another note.', options)
      expect(listKey(await render(FOOTNOTED, options))).toBe(listKey(first))
    })
  })

  it('keeps every piece of a note larger than its capacity, so only an edited piece is sent again', async () => {
    const render = createPieceRenderer({ capacity: 20, pieceLength: 1 })
    const note = (edit: string) =>
      [...Array(20).keys()].map((i) => `Piece ${i}${edit}.`).join('\n\n')
    const first = await render(note(''), options)
    const shown = first.map((p) => p.key)
    const edited = await render(note('').replace('Piece 7.', 'Piece 7 edited.'), options, shown)
    expect(edited.filter((p) => p.nodes !== undefined).map((p) => p.line)).toEqual([15])
  })

  it('keeps every piece the note shows through a sample it renders but does not show', async () => {
    const render = createPieceRenderer({ capacity: 20, pieceLength: 1 })
    const note = [...Array(20).keys()].map((i) => `Piece ${i}.`).join('\n\n')
    const first = await render(note, options)
    await render.sample('Sample one.\n\nSample two.\n\nSample three.', options)
    const again = await render(note, options)
    expect(again.map((p) => p.key)).toEqual(first.map((p) => p.key))
  })
})
