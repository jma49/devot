import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import { renderPreviewPieces } from '../../src/core'
import { createSlugger, fragmentId, ID_PREFIX, slug } from '../../src/core/preview/headingIds'
import { labels, previewTree as render } from '../support/preview-html'

function headings(tree: Root | Element): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}

function ids(nodes: readonly RootContent[]): string[] {
  return nodes.flatMap((node) =>
    node.type === 'element'
      ? [
          ...(node.properties['id'] === undefined ? [] : [String(node.properties['id'])]),
          ...ids(node.children),
        ]
      : [],
  )
}

const appSources = () =>
  readdirSync('src/renderer', { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(tsx?|html)$/.test(name))
    .map((name) => readFileSync(join('src/renderer', name), 'utf8'))

/** Every literal id the app's own pages and components give an element. */
const appIds = () => [
  ...new Set(
    appSources().flatMap((source) => [...source.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]!)),
  ),
]

// Written as code points: a test file holds no CJK characters.
const ZH = String.fromCodePoint(0x4e2d, 0x6587)

describe('slug', () => {
  it.each([
    ['Hello World', 'hello-world'],
    ['What is this?', 'what-is-this'],
    ['  Trim ', '--trim-'],
    ['snake_case & kebab-case', 'snake_case--kebab-case'],
    ['Café Über', 'café-über'],
    [`${ZH} ${ZH}`, `${ZH}-${ZH}`],
    ['Party 🎉 time', 'party--time'],
    ['🎉', ''],
    ['', ''],
  ])('turns %j into %j', (text, expected) => {
    expect(slug(text)).toBe(expected)
  })
})

describe('createSlugger', () => {
  it('numbers repeats and avoids a heading named like a repeat', () => {
    const next = createSlugger()
    expect([next('A'), next('A'), next('a'), next('a-1'), next('A')]).toEqual([
      'a',
      'a-1',
      'a-2',
      'a-1-1',
      'a-3',
    ])
  })
})

describe('heading ids in the preview', () => {
  it('gives every heading an id, repeats a number, and skips an empty slug', async () => {
    const tree = await render(
      `# Intro\n\n## Intro\n\n> ### **Bold** ${'`code`'}\n\n#### 🎉\n\n##### ${ZH}`,
    )
    expect(headings(tree).map((h) => h.properties['id'])).toEqual([
      'user-content-intro',
      'user-content-intro-1',
      'user-content-bold-code',
      undefined,
      `user-content-${ZH}`,
    ])
  })

  it('leaves an id the note wrote to the sanitizer', async () => {
    const tree = await render('<h2 id="mine">Title</h2>')
    expect(headings(tree)[0]?.properties['id']).toBe('user-content-mine')
  })

  it('never gives an element an id the app gives one of its own', async () => {
    const app = appIds()
    expect(app).toEqual(expect.arrayContaining(['root', 'confirm-message', 'confirm-detail']))
    const named = [...app, 'palette-option-0', 'palette-keys']
    const markdown = [
      ...named.map((id) => `## ${id.replace(/-/g, ' ')}`),
      '<h2 id="root">Raw</h2>',
      'Note[^1]',
      '[^1]: A footnote.',
    ].join('\n\n')
    const pieces = await renderPreviewPieces(markdown, { labels, loadedEmbeds: [] })
    for (const nodes of [(await render(markdown)).children, pieces.flatMap((p) => p.nodes ?? [])]) {
      const given = ids(nodes)
      expect(given.length).toBeGreaterThan(named.length)
      expect(given.filter((id) => app.includes(id))).toEqual([])
      expect(given.filter((id) => !id.startsWith(ID_PREFIX))).toEqual([])
    }
    // Ids the app builds at run time (`palette-option-${i}`) never take the prefix either.
    expect(appSources().filter((source) => source.includes(ID_PREFIX))).toEqual([])
  })
})

describe('fragmentId', () => {
  it('is the prefixed id a `#fragment` link means, prefixed once', () => {
    expect(fragmentId('the-end')).toBe('user-content-the-end')
    expect(fragmentId('user-content-fn-1')).toBe('user-content-fn-1')
  })
})
