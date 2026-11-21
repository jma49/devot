import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { parser, GFM } = require('@lezer/markdown') as typeof import('@lezer/markdown')
const { TreeCursor, TreeFragment } = require('@lezer/common') as typeof import('@lezer/common')

describe('the CommonJS Markdown parser', () => {
  it('reuses groups around an edit and agrees with a whole parse', () => {
    const markdown = parser.configure(GFM)
    const doc = '## Heading\n\nA paragraph with **bold**.\n\n- an item\n\n'.repeat(400)
    const tree = markdown.parse(doc)
    const next = 'w' + doc
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
      { fromA: 0, toA: 0, fromB: 0, toB: 1 },
    ])
    const spy = vi.spyOn(TreeCursor.prototype, 'nextSibling')
    let reused: typeof tree
    let steps: number
    try {
      reused = markdown.parse(next, fragments)
      steps = spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
    const nodes = (value: typeof tree) => {
      const result: string[] = []
      const cursor = value.cursor()
      do result.push(`${cursor.name}:${cursor.from}-${cursor.to}`)
      while (cursor.next())
      return result
    }
    expect(nodes(reused)).toEqual(nodes(markdown.parse(next)))
    let blocks = 0
    for (let block = tree.topNode.firstChild; block; block = block.nextSibling) blocks++
    expect(blocks).toBeGreaterThan(1000)
    expect(steps).toBeLessThan(blocks / 2)
  })
})
