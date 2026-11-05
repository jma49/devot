import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  CARD_EXCERPT_BLOCKS,
  CARD_EXCERPT_CHARS,
  CARD_EXCERPT_LINES,
  cardExcerpt,
  renderCardPreview,
  type CardLabels,
} from '../../src/core/preview/card'
import { expectWithinBudget } from '../support/budget'

const labels: CardLabels = {
  diagram: 'Diagram',
  math: 'Math',
  embed: 'Embed',
  image: 'Image',
  alerts: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  },
}

function elements(nodes: readonly RootContent[]): Element[] {
  return nodes.flatMap((node) =>
    node.type === 'element' ? [node, ...elements(node.children)] : [],
  )
}

const tags = (tree: Root) => elements(tree.children).map((el) => el.tagName)
const classes = (el: Element) => (el.properties['className'] as string[] | undefined) ?? []
const textOf = (nodes: readonly RootContent[]): string =>
  nodes
    .map((node) =>
      node.type === 'text' ? node.value : node.type === 'element' ? textOf(node.children) : '',
    )
    .join('')

describe('cardExcerpt', () => {
  it('keeps a short note whole', () => {
    expect(cardExcerpt('# Plan\n\n- one\n- two\n')).toBe('# Plan\n\n- one\n- two\n')
  })

  it('leaves out front matter', () => {
    expect(cardExcerpt('---\ntags: [a]\n---\nBody text')).toBe('Body text')
  })

  it('stops at whole blocks once the characters run out', () => {
    const paragraph = 'word '.repeat(60).trim()
    const note = Array.from({ length: 20 }, () => paragraph).join('\n\n')
    const excerpt = cardExcerpt(note)
    expect(excerpt.length).toBeLessThanOrEqual(CARD_EXCERPT_CHARS)
    expect(excerpt.split('\n\n').every((block) => block === paragraph)).toBe(true)
  })

  it('takes at most a fixed number of blocks', () => {
    const note = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join('\n\n')
    expect(cardExcerpt(note).split('\n\n')).toHaveLength(CARD_EXCERPT_BLOCKS)
  })

  it('cuts one long block by lines, and closes a code fence it cuts', () => {
    const code = Array.from({ length: 200 }, (_, i) => `let x${i} = ${i}`).join('\n')
    const excerpt = cardExcerpt('```ts\n' + code + '\n```\n\nAfter')
    const lines = excerpt.split('\n')
    expect(lines[0]).toBe('```ts')
    expect(lines.at(-1)).toBe('```')
    expect(lines.length).toBeLessThanOrEqual(CARD_EXCERPT_LINES + 1)
    expect(excerpt).not.toContain('After')
  })

  it('cuts a single very long line at the character cap', () => {
    const excerpt = cardExcerpt('a'.repeat(1_000_000))
    expect(excerpt.length).toBe(CARD_EXCERPT_CHARS)
  })

  it('is empty for an empty note', () => {
    expect(cardExcerpt('')).toBe('')
  })

  it('reads only the start of a huge note', (context) => {
    const note = '# Heading\n\n' + 'Some text here.\n\n'.repeat(200_000)
    const start = performance.now()
    for (let i = 0; i < 100; i += 1) cardExcerpt(note)
    expectWithinBudget(context, performance.now() - start, 50)
  })
})

describe('renderCardPreview', () => {
  it('renders headings, lists, task boxes, tables, code and images', async () => {
    const tree = await renderCardPreview(
      [
        '# Title',
        '',
        'Some **bold** text',
        '',
        '- [x] done',
        '- [ ] open',
        '',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '```js',
        'let a = 1',
        '```',
        '',
        '![Plan](devot://file/0192a6f0-0000-7000-8000-00000000000a)',
      ].join('\n'),
      labels,
    )
    const found = tags(tree)
    for (const tag of ['h1', 'strong', 'ul', 'input', 'table', 'pre', 'img']) {
      expect(found).toContain(tag)
    }
  })

  it('leaves task boxes read-only and takes ids off, so cards never repeat one', async () => {
    const tree = await renderCardPreview('# Same\n\n- [ ] task\n\nNote[^1]\n\n[^1]: foot', labels)
    const all = elements(tree.children)
    expect(
      all.filter((el) => el.tagName === 'input').every((el) => el.properties['disabled']),
    ).toBe(true)
    expect(all.some((el) => el.properties['id'] !== undefined)).toBe(false)
  })

  it('shows a placeholder for diagrams and never draws them', async () => {
    for (const language of ['mermaid', 'plantuml', 'puml', 'markmap']) {
      const tree = await renderCardPreview('```' + language + '\ngraph TD; A-->B\n```', labels)
      const all = elements(tree.children)
      expect(all.some((el) => el.properties['dataDevotIsland'] !== undefined)).toBe(false)
      const placeholder = all.find((el) => classes(el).includes('card-placeholder'))
      expect(placeholder && textOf([placeholder])).toBe('Diagram')
    }
  })

  it('shows a placeholder for math, inline and display', async () => {
    const tree = await renderCardPreview('Inline $x^2$ here\n\n$$\ny = mx + b\n$$', labels)
    const all = elements(tree.children)
    expect(all.some((el) => el.tagName === 'math')).toBe(false)
    const placeholders = all.filter((el) => classes(el).includes('card-placeholder'))
    expect(placeholders.map((el) => [el.tagName, textOf([el])])).toEqual([
      ['span', 'Math'],
      ['div', 'Math'],
    ])
  })

  it('loads nothing from the web: remote images and frames are placeholders', async () => {
    const tree = await renderCardPreview(
      '![x](https://example.com/a.png)\n\n<iframe src="https://example.com/embed"></iframe>',
      labels,
    )
    const all = elements(tree.children)
    expect(all.some((el) => el.tagName === 'img' || el.tagName === 'iframe')).toBe(false)
    expect(
      all.filter((el) => classes(el).includes('card-placeholder')).map((el) => textOf([el])),
    ).toEqual(['Image', 'Embed'])
  })

  it('still sanitizes the note: scripts and handlers never reach a card', async () => {
    const tree = await renderCardPreview('<script>x()</script><b onclick="y()">hi</b>', labels)
    const all = elements(tree.children)
    expect(all.some((el) => el.tagName === 'script')).toBe(false)
    expect(all.some((el) => el.properties['onClick'] !== undefined)).toBe(false)
  })

  it('renders the capped starts of large notes quickly', async (context) => {
    const note = cardExcerpt(
      Array.from(
        { length: 400 },
        (_, i) =>
          `## Part ${i}\n\nSome *text* with a [link](https://example.com) and \`code\`.\n\n- a\n- b`,
      ).join('\n\n'),
    )
    await renderCardPreview(note, labels)
    const start = performance.now()
    for (let i = 0; i < 50; i += 1) await renderCardPreview(note, labels)
    expectWithinBudget(context, performance.now() - start, 400)
  })
})
