import type { Element, Root, RootContent } from 'hast'
import { describe, expect, it } from 'vitest'
import { createSlugger, slug } from '../../src/core/preview/headingIds'
import { previewTree as render } from '../support/preview-html'

function headings(tree: Root | Element): Element[] {
  const out: Element[] = []
  const walk = (node: Root | RootContent) => {
    if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) out.push(node)
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return out
}

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
      'intro',
      'intro-1',
      'bold-code',
      undefined,
      ZH,
    ])
  })

  it('leaves an id the note wrote to the sanitizer', async () => {
    const tree = await render('<h2 id="mine">Title</h2>')
    expect(headings(tree)[0]?.properties['id']).toBe('user-content-mine')
  })
})
