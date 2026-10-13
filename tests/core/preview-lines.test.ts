import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import {
  PREVIEW_API_VERSION,
  createPreviewRegistry,
  renderPreview,
  type PreviewLabels,
} from '../../src/core'

// Synced scrolling maps editor lines to preview blocks: every block the
// preview shows carries the source line it starts on, as `data-source-line`.

const labels: PreviewLabels = {
  alerts: {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
  },
  embedFrom: 'Embedded content from {origin}',
  embedLoad: 'Load',
  videoTitle: 'Embedded video',
}

const render = (md: string) => renderPreview(md, { labels, loadedEmbeds: [] })

function elements(tree: Root | Element): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element') out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}

const classes = (e: Element) => (e.properties['className'] as string[] | undefined) ?? []
const line = (e: Element | undefined) => e?.properties['dataSourceLine']
const first = (tree: Root, test: (e: Element) => boolean) => elements(tree).find(test)

describe('source lines', () => {
  it('marks every block with the line it starts on', async () => {
    const tree = await render(
      [
        '# Title', // 1
        '',
        'A paragraph', // 3
        'over two lines.',
        '',
        '- one', // 6
        '- two', // 7
        '',
        '  more of two', // 9
        '',
        '```js', // 11
        'code()',
        '```',
        '',
        '> quoted', // 15
        '',
        '| a | b |', // 17
        '| - | - |',
        '| 1 | 2 |', // 19
        '',
        '---', // 21
      ].join('\n'),
    )
    expect(line(first(tree, (e) => e.tagName === 'h1'))).toBe(1)
    expect(line(first(tree, (e) => e.tagName === 'p'))).toBe(3)
    expect(line(first(tree, (e) => e.tagName === 'ul'))).toBe(6)
    expect(
      elements(tree)
        .filter((e) => e.tagName === 'li')
        .map(line),
    ).toEqual([6, 7])
    expect(line(first(tree, (e) => e.tagName === 'pre'))).toBe(11)
    expect(line(first(tree, (e) => e.tagName === 'blockquote'))).toBe(15)
    expect(line(first(tree, (e) => e.tagName === 'table'))).toBe(17)
    expect(
      elements(tree)
        .filter((e) => e.tagName === 'tr')
        .map(line),
    ).toEqual([17, 19])
    expect(line(first(tree, (e) => e.tagName === 'hr'))).toBe(21)
  })

  it('leaves inline elements unmarked', async () => {
    const tree = await render('Some *emphasis* and `code` and [a link](https://example.com).')
    for (const tag of ['em', 'code', 'a']) {
      expect(line(first(tree, (e) => e.tagName === tag))).toBeUndefined()
    }
  })

  it('keeps the line of a block a renderer replaced', async () => {
    const tree = await render(
      [
        '---', // 1
        'title: x',
        '---',
        '',
        '> [!NOTE]', // 5
        '> An alert.',
        '',
        '```mermaid', // 8
        'graph TD',
        '```',
        '',
        '$$', // 12
        'x^2',
        '$$',
        '',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ', // 16
        '',
        '<iframe src="https://example.com/x"></iframe>', // 18
      ].join('\n'),
    )
    expect(line(first(tree, (e) => classes(e).includes('frontmatter')))).toBe(1)
    expect(line(first(tree, (e) => classes(e).includes('alert')))).toBe(5)
    expect(line(first(tree, (e) => classes(e).includes('island-mermaid')))).toBe(8)
    expect(line(first(tree, (e) => classes(e).includes('math-display')))).toBe(12)
    expect(line(first(tree, (e) => classes(e).includes('embed-video')))).toBe(16)
    expect(line(first(tree, (e) => classes(e).includes('embed-placeholder')))).toBe(18)
  })

  it('marks raw HTML blocks by their own line and never takes a line from the note', async () => {
    const tree = await render(
      ['Text', '', '<div data-source-line="99" data-devot-ui data-x="1">raw</div>'].join('\n'),
    )
    const div = first(tree, (e) => e.tagName === 'div')
    // The sanitizer drops the note's own data attributes: the line is Devot's,
    // and no note can pass for the page's own controls (`data-devot-ui`).
    expect(div?.properties).toEqual({ dataSourceLine: 3 })
  })

  it('counts lines after front matter as the editor does', async () => {
    const tree = await render(['---', 'a: 1', '---', '# After'].join('\n'))
    expect(line(first(tree, (e) => e.tagName === 'h1'))).toBe(4)
  })

  it('leaves a block without a source position unmarked', async () => {
    const registry = createPreviewRegistry({ builtins: true })
    registry.register({
      id: 'test.replace-paragraphs',
      apiVersion: PREVIEW_API_VERSION,
      transform(tree) {
        tree.children = tree.children.map((child) =>
          child.type === 'element' && child.tagName === 'p'
            ? { type: 'element', tagName: 'section', properties: {}, children: [] }
            : child,
        )
      },
    })
    const tree = await renderPreview('# A\n\nb', { labels, loadedEmbeds: [] }, registry)
    // Without a position the block has no line; scrolling interpolates over it.
    expect(line(first(tree, (e) => e.tagName === 'section'))).toBeUndefined()
    expect(line(first(tree, (e) => e.tagName === 'h1'))).toBe(1)
  })

  it('leaves no positions in the tree it returns', async () => {
    const tree = await render('# A\n\n- b')
    expect(elements(tree).some((e) => e.position !== undefined)).toBe(false)
  })
})

describe('code blocks', () => {
  it('renders no copy button: the page adds it, so the HTML never holds it', async () => {
    const tree = await render('```html\n<b>&amp;</b>\n  indented\n```')
    expect(elements(tree).map((e) => e.tagName)).toEqual(['pre', 'code'])
    const code = first(tree, (e) => e.tagName === 'code')
    expect(code?.children).toEqual([{ type: 'text', value: '<b>&amp;</b>\n  indented\n' }])
  })
})
