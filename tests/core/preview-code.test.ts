import type { Element, Root } from 'hast'
import { describe, expect, it } from 'vitest'
import { codeTitle } from '../../src/core/preview/code'
import { pageBody } from '../../src/core'
import { previewTree } from '../support/preview-html'

const find = (node: Root | Element, test: (e: Element) => boolean): Element[] =>
  node.children.flatMap((c) =>
    c.type === 'element' ? [...(test(c) ? [c] : []), ...find(c, test)] : [],
  )
const heads = (tree: Root) =>
  find(
    tree,
    (e) => (e.properties['className'] as string[] | undefined)?.includes('code-head') === true,
  )
const text = (e: Element): string =>
  e.children
    .map((c) => (c.type === 'text' ? c.value : c.type === 'element' ? text(c) : ''))
    .join('')

describe('code block title bar', () => {
  it('shows the title and the language mark', async () => {
    const tree = await previewTree('```ts title="example.ts"\nconst a = 1\n```\n')
    const [head] = heads(tree)
    expect(text(head!)).toBe('example.ts')
    expect(find(head!, (e) => e.tagName === 'path')).toHaveLength(1)
  })

  it('names the language when there is no title, and marks unknown ones', async () => {
    const known = heads(await previewTree('```rust\nfn main() {}\n```\n'))
    expect(text(known[0]!)).toBe('Rust')
    const other = heads(await previewTree('```brainfuck\n+\n```\n'))
    expect(text(other[0]!)).toBe('brainfuck')
  })

  it('leaves bare blocks, front matter and diagrams without a bar', async () => {
    expect(heads(await previewTree('```\nplain\n```\n'))).toHaveLength(0)
    expect(heads(await previewTree('---\na: 1\n---\n\ntext\n'))).toHaveLength(0)
    expect(heads(await previewTree('```mermaid\ngraph TD; A-->B\n```\n'))).toHaveLength(0)
  })

  it('keeps the info string out of the page and the bar out of simple HTML', async () => {
    const tree = await previewTree('```ts title="x.ts"\nlet a\n```\n')
    const full = pageBody(tree, { nonce: 'a'.repeat(32) }).html
    expect(full).toContain('code-head')
    expect(full).not.toContain('data-meta')
    expect(pageBody(tree, { nonce: 'a'.repeat(32), simple: true }).html).not.toContain('x.ts')
  })

  it('reads quoted and bare titles and cuts long ones', () => {
    expect(codeTitle('title="a b"')).toBe('a b')
    expect(codeTitle("{1} title='a.ts'")).toBe('a.ts')
    expect(codeTitle('title=a.ts')).toBe('a.ts')
    expect(codeTitle('subtitle=x')).toBeNull()
    expect(codeTitle('title=""')).toBeNull()
    expect(codeTitle(`title="${'x'.repeat(300)}"`)?.length).toBe(120)
  })
})
