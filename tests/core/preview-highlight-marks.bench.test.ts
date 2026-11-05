import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, it } from 'vitest'
import { remarkHighlightMarks } from '../../src/core/preview/highlightMarks'
import { expectLinearGrowth, fourfoldGrowth, GROWTH_TIMEOUT } from '../support/growth'

const parser = unified().use(remarkParse)

const COPIES = 8

/**
 * Parsed once per size; each round marks fresh copies, as the pass changes the tree. Many small
 * trees per timing keep each one in cache and average out collector pauses that one large tree
 * would suffer unevenly.
 */
function marking(unit: string): (n: number) => () => void {
  const parsed = new Map<number, { note: string; tree: Root }>()
  return (n) => {
    let known = parsed.get(n)
    if (!known) {
      const note = unit.repeat(n)
      known = { note, tree: parser.parse(note) as Root }
      parsed.set(n, known)
    }
    const { note } = known
    const trees = Array.from({ length: COPIES }, () => structuredClone(known.tree))
    const transform = remarkHighlightMarks()
    return () => {
      for (const tree of trees) transform(tree, { value: note })
    }
  }
}

describe('highlight marks in a long paragraph', () => {
  it(
    'takes time linear in the number of marks',
    (context) => {
      const growth = fourfoldGrowth(marking('==mark== word '), 1_000, 15)
      expectLinearGrowth(context, growth)
    },
    GROWTH_TIMEOUT,
  )

  it(
    'takes time linear in marks that sit between other inline nodes',
    (context) => {
      const growth = fourfoldGrowth(marking('==a *b*== c '), 1_000, 15)
      expectLinearGrowth(context, growth)
    },
    GROWTH_TIMEOUT,
  )
})
