import type { Link, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { noteLink } from '../../src/core'

const ID = '0192a6f0-0000-7000-8000-0000000000ff'

const parse = (markdown: string) =>
  unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root

const find = (node: Root | Root['children'][number], type: string): unknown => {
  if (node.type === type) return node
  if ('children' in node) {
    for (const child of node.children) {
      const hit = find(child, type)
      if (hit) return hit
    }
  }
  return undefined
}

const linkIn = (markdown: string): Link => {
  const link = find(parse(markdown), 'link')
  if (!link) throw new Error('no link')
  return link as Link
}

const linkText = (link: Link) => {
  const [only] = link.children
  return link.children.length === 1 && only?.type === 'text' ? only.value : null
}

describe('a note link', () => {
  it('renders a title with a pipe as one table cell, the link whole', () => {
    const title = 'Pipe | name'
    const markdown = `| Head |\n| --- |\n| ${noteLink(title, ID)} |\n`
    const table = find(parse(markdown), 'table') as { children: { children: unknown[] }[] }
    const row = table.children[1]!
    expect(row.children).toHaveLength(1)
    expect(linkText(linkIn(markdown))).toBe(title)
  })

  it('keeps Markdown punctuation in a title as text, not formatting', () => {
    for (const title of [
      'Star *bold* _x_ `c`',
      'A `tick',
      '<tag> and ~strike~',
      'Tom & Jerry',
      'a \\ b [c]',
    ]) {
      expect(linkText(linkIn(noteLink(title, ID)))).toBe(title)
    }
  })
})
